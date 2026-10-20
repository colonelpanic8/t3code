package expo.modules.t3evaextension.assistant

class InvalidArgumentsException(message: String) : IllegalArgumentException(message)

/**
 * Journaled write operations. [completed] and [uncertain] are the receipt
 * sentences when the executor reports no summary of its own; `{env}` becomes
 * " on <environment>" or nothing.
 */
enum class AssistantOperation(val wire: String, val completed: String, val uncertain: String) {
  START_THREAD(
    "start_thread",
    "The new thread{env} received the prompt in T3 Code.",
    "T3 Code cannot tell whether the thread started. Check in T3 Code before trying again.",
  ),
  SEND_MESSAGE(
    "send_message",
    "The thread{env} received the message in T3 Code.",
    "T3 Code cannot tell whether the thread received the message. Check in T3 Code before " +
      "trying again.",
  ),
  INTERRUPT_THREAD(
    "interrupt_thread",
    "T3 Code stopped the thread's turn{env}.",
    "T3 Code cannot tell whether the turn stopped. Read the thread's status before trying again.",
  ),
  ORGANIZE_THREAD(
    "organize_thread",
    "T3 Code updated the thread{env}.",
    "T3 Code cannot tell whether the thread changed. Read its status before trying again.",
  ),
  RESPOND_TO_APPROVAL(
    "respond_to_approval",
    "T3 Code answered the approval{env}.",
    "T3 Code cannot tell whether the approval was answered. List pending requests before " +
      "trying again.",
  ),
  ANSWER_QUESTION(
    "answer_question",
    "T3 Code answered the question{env}.",
    "T3 Code cannot tell whether the answer arrived. List pending requests before trying again.",
  ),
  DISMISS_QUESTION(
    "dismiss_question",
    "T3 Code dismissed the question{env}.",
    "T3 Code cannot tell whether the question was dismissed. List pending requests before " +
      "trying again.",
  ),
  RENAME_THREAD(
    "rename_thread",
    "T3 Code renamed the thread{env}.",
    "T3 Code cannot tell whether the thread was renamed. Check in T3 Code before trying again.",
  ),
  CONFIGURE_THREAD(
    "configure_thread",
    "T3 Code changed the thread's settings{env}.",
    "T3 Code cannot tell whether the settings changed. Read the thread's status before trying " +
      "again.",
  ),
  FORK_THREAD(
    "fork_thread",
    "T3 Code forked the thread{env}.",
    "T3 Code cannot tell whether the fork was created. List threads before trying again.",
  ),
  MANAGE_QUEUED_MESSAGE(
    "manage_queued_message",
    "T3 Code updated the thread's queue{env}.",
    "T3 Code cannot tell whether the queue changed. List the queued messages before trying " +
      "again.",
  )
  ;

  companion object {
    fun fromWire(value: String): AssistantOperation? = entries.firstOrNull { it.wire == value }
  }
}

const val REQUEST_STATUS_CAPABILITY = "request_status"
const val MAX_PROMPT_LENGTH = 16_000

private const val ID_MAX = 200
private const val MAX_SNOOZE_MINUTES = 60 * 24 * 365L
private const val MAX_ANSWER_LENGTH = 4_000
private const val MAX_ANSWERS_JSON_LENGTH = 8_000
private const val MAX_MODEL_OPTIONS_LENGTH = 500

sealed class Field(val name: String, val description: String) {
  abstract fun schema(): Map<String, Any?>

  abstract fun validate(value: Any?): Any

  class Text(
    name: String,
    description: String,
    private val min: Int = 1,
    private val max: Int = ID_MAX
  ) : Field(name, description) {
    override fun schema(): Map<String, Any?> =
      linkedMapOf(
        "type" to "string",
        "minLength" to min,
        "maxLength" to max,
        "description" to description
      )

    override fun validate(value: Any?): Any {
      val text = value as? String ?: throw InvalidArgumentsException("$name must be a string")
      val length = text.codePointCount(0, text.length)
      if (length < min ||
        length > max
      ) {
        throw InvalidArgumentsException("$name must be $min to $max characters")
      }
      if (text.isBlank()) throw InvalidArgumentsException("$name must not be blank")
      return text
    }
  }

  class Choice(name: String, description: String, private val values: List<String>) : Field(
    name,
    description
  ) {
    override fun schema(): Map<String, Any?> = linkedMapOf(
      "type" to "string",
      "enum" to values,
      "description" to description
    )

    override fun validate(value: Any?): Any {
      val text = value as? String ?: throw InvalidArgumentsException("$name must be a string")
      if (text !in
        values
      ) {
        throw InvalidArgumentsException("$name must be one of ${values.joinToString()}")
      }
      return text
    }
  }

  // EVA's schema dialect has no minimum or maximum; the bounds are enforced here only.
  class Whole(name: String, description: String, private val min: Long, private val max: Long) :
    Field(name, description) {
    override fun schema(): Map<String, Any?> =
      linkedMapOf("type" to "integer", "description" to description)

    override fun validate(value: Any?): Any {
      val number = value as? Long ?: throw InvalidArgumentsException("$name must be an integer")
      if (number < min ||
        number > max
      ) {
        throw InvalidArgumentsException("$name must be $min to $max")
      }
      return number
    }
  }
}

@Suppress("LongParameterList")
class Capability(
  val name: String,
  val title: String,
  val description: String,
  val effects: String,
  val maxWaitMillis: Long,
  val fields: List<Field>,
  val required: List<String>,
  /** Field combinations the flat schema cannot express. */
  private val checkCombination: (Map<String, Any?>) -> Unit = {}
) {
  fun inputSchema(): Map<String, Any?> =
    linkedMapOf(
      "type" to "object",
      "properties" to fields.associate { it.name to it.schema() },
      "required" to required,
      "additionalProperties" to false,
    )

  /** Rejects unknown, missing, and mistyped fields; returns only the fields that were sent. */
  fun validate(arguments: Map<String, Any?>): Map<String, Any?> {
    val known = fields.associateBy { it.name }
    val unknown = arguments.keys.filterNot { it in known }
    if (unknown.isNotEmpty()) throw InvalidArgumentsException("Unknown argument ${unknown.first()}")
    for (name in required) {
      if (arguments[name] == null) throw InvalidArgumentsException("$name is required")
    }
    val result = LinkedHashMap<String, Any?>()
    for ((name, value) in arguments) {
      // Absent and null mean the same thing for optional fields.
      if (value == null) continue
      result[name] = known.getValue(name).validate(value)
    }
    checkCombination(result)
    return result
  }
}

private val environmentId =
  Field.Text("environmentId", "Environment ID from the T3 Code projects or threads catalog.")
private val threadId =
  Field.Text("threadId", "Thread ID from the T3 Code threads catalog, for the same environmentId.")
private val prompt = Field.Text("prompt", "The message to send.", max = MAX_PROMPT_LENGTH)
private val requestId =
  Field.Text(
    "requestId",
    "Request ID from T3 Code's pending requests list, for the same environmentId and threadId."
  )
private val provider =
  Field.Text(
    "provider",
    "Provider instance ID from the T3 Code models catalog for this environmentId."
  )
private val modelOptions =
  Field.Text(
    "modelOptions",
    "Model options as comma-separated id=value pairs, such as effort=high, using only the ids " +
      "and values the models catalog lists in that model's options column.",
    max = MAX_MODEL_OPTIONS_LENGTH,
  )
private val runtimeMode =
  Field.Choice(
    "runtimeMode",
    "How much the agent may do without asking.",
    listOf("approval-required", "auto-accept-edits", "auto", "full-access"),
  )
private val interactionMode =
  Field.Choice(
    "interactionMode",
    "plan asks the agent to plan before building.",
    listOf("default", "plan")
  )

private const val PENDING_HINT =
  "accepted, submitted, or waiting_for_host mean T3 Code is still working on it: call " +
    "request_status " +
    "with this invocation's ID instead of calling it again."

@Suppress("LongParameterList")
private fun write(
  operation: AssistantOperation,
  title: String,
  description: String,
  fields: List<Field>,
  required: List<String>,
  checkCombination: (Map<String, Any?>) -> Unit = {}
) = Capability(
  name = operation.wire,
  title = title,
  description = "$description $PENDING_HINT",
  effects = "write",
  maxWaitMillis = 25_000,
  fields = fields,
  required = required,
  checkCombination = checkCombination,
)

private fun requireOnlyWith(
  arguments: Map<String, Any?>,
  field: String,
  condition: Boolean,
  explanation: String
) {
  if (arguments.containsKey(field) && !condition) {
    throw InvalidArgumentsException("$field $explanation")
  }
}

object AssistantCapabilities {
  val startThread =
    write(
      AssistantOperation.START_THREAD,
      title = "Start a T3 Code thread",
      description =
        "Start a new coding thread in a T3 Code project with an initial prompt. " +
          "Use environmentId and projectId exactly as listed by the T3 Code projects catalog. " +
          "state=completed means the thread exists and received the prompt, not that its task " +
          "is done. " +
          "The receipt names the environment as environmentName and the new thread as threadId.",
      fields =
        listOf(
          environmentId,
          Field.Text(
            "projectId",
            "Project ID from the T3 Code projects catalog, for the same environmentId."
          ),
          prompt,
          Field.Text("title", "Thread title. Defaults to one derived from the prompt.", max = 200),
          Field.Text(
            "provider",
            "Provider instance ID from the T3 Code models catalog for this environmentId. " +
              "Defaults to the project's default model, else the first ready provider.",
          ),
          Field.Text(
            "model",
            "Model ID from the T3 Code models catalog for this provider. Defaults to the " +
              "provider's default model."
          ),
          modelOptions,
          Field.Choice(
            "runtimeMode",
            "How much the agent may do without asking. Defaults to full-access, T3 Code's default.",
            listOf("approval-required", "auto-accept-edits", "auto", "full-access"),
          ),
          Field.Choice(
            "interactionMode",
            "plan asks the agent to plan before building. Defaults to default.",
            listOf("default", "plan")
          ),
          Field.Choice(
            "workspace",
            "local (default) works in the project directory; worktree starts a new branch in a " +
              "new git worktree; branch checks out an existing branch in a worktree; " +
              "pull_request checks out a pull request in a worktree.",
            listOf("local", "worktree", "branch", "pull_request"),
          ),
          Field.Text(
            "baseBranch",
            "Only with workspace=worktree: branch the worktree starts from. Defaults to the " +
              "project's current branch.",
            max = 300,
          ),
          Field.Text(
            "branch",
            "Required with workspace=branch: existing branch to work on. A worktree that " +
              "already has it checked out is reused.",
            max = 300,
          ),
          Field.Text(
            "pullRequest",
            "Required with workspace=pull_request: pull request number or URL.",
            max = 500,
          ),
        ),
      required = listOf("environmentId", "projectId", "prompt"),
    ) { arguments ->
      val workspace = arguments["workspace"]
      requireOnlyWith(
        arguments,
        "baseBranch",
        workspace == "worktree",
        "requires workspace=worktree"
      )
      requireOnlyWith(arguments, "branch", workspace == "branch", "requires workspace=branch")
      requireOnlyWith(
        arguments,
        "pullRequest",
        workspace == "pull_request",
        "requires workspace=pull_request"
      )
      if (workspace == "branch" && !arguments.containsKey("branch")) {
        throw InvalidArgumentsException("workspace=branch requires branch")
      }
      if (workspace == "pull_request" && !arguments.containsKey("pullRequest")) {
        throw InvalidArgumentsException("workspace=pull_request requires pullRequest")
      }
      requireOnlyWith(arguments, "model", arguments.containsKey("provider"), "requires provider")
    }

  val sendMessage =
    write(
      AssistantOperation.SEND_MESSAGE,
      title = "Send a message to a T3 Code thread",
      description =
        "Send a message to an existing T3 Code thread. Use environmentId and threadId from the " +
          "T3 Code threads catalog. " +
          "state=completed means the thread accepted the message.",
      fields =
        listOf(
          environmentId,
          threadId,
          prompt,
          Field.Choice(
            "activeTurnBehavior",
            "What to do if the thread is mid-turn: steer (default) adds the message to the " +
              "running turn; " +
              "queue sends it when the turn ends; restart stops the turn and starts again with " +
              "this message.",
            listOf("steer", "queue", "restart"),
          ),
        ),
      required = listOf("environmentId", "threadId", "prompt"),
    )

  val interruptThread =
    write(
      AssistantOperation.INTERRUPT_THREAD,
      title = "Stop a T3 Code thread's turn",
      description =
        "Stop the turn a T3 Code thread is running, like pressing Stop. Queued messages stay " +
          "queued. state=completed means T3 Code accepted the stop.",
      fields = listOf(environmentId, threadId),
      required = listOf("environmentId", "threadId"),
    )

  val organizeThread =
    write(
      AssistantOperation.ORGANIZE_THREAD,
      title = "Organize a T3 Code thread",
      description =
        "Pin, unpin, snooze, unsnooze, settle (mark done), unsettle, archive, unarchive, or mark " +
          "a T3 Code thread unread. snooze needs snoozeMinutes or snoozeUntil.",
      fields =
        listOf(
          environmentId,
          threadId,
          Field.Choice(
            "action",
            "What to do with the thread.",
            listOf(
              "pin",
              "unpin",
              "snooze",
              "unsnooze",
              "settle",
              "unsettle",
              "archive",
              "unarchive",
              "mark_unread"
            ),
          ),
          Field.Whole(
            "snoozeMinutes",
            "Only with action=snooze: minutes from now until the thread returns, 1 or more.",
            1,
            MAX_SNOOZE_MINUTES,
          ),
          Field.Text(
            "snoozeUntil",
            "Only with action=snooze: ISO 8601 date-time with offset when the thread returns, " +
              "such as 2026-10-20T09:00:00-07:00.",
            max = 40,
          ),
        ),
      required = listOf("environmentId", "threadId", "action"),
    ) { arguments ->
      val snooze = arguments["action"] == "snooze"
      requireOnlyWith(arguments, "snoozeMinutes", snooze, "requires action=snooze")
      requireOnlyWith(arguments, "snoozeUntil", snooze, "requires action=snooze")
      if (snooze &&
        arguments.containsKey("snoozeMinutes") == arguments.containsKey("snoozeUntil")
      ) {
        throw InvalidArgumentsException("action=snooze takes snoozeMinutes or snoozeUntil")
      }
    }

  val respondToApproval =
    write(
      AssistantOperation.RESPOND_TO_APPROVAL,
      title = "Answer a T3 Code approval",
      description =
        "Approve or deny an action a T3 Code thread is waiting on. Take requestId from the " +
          "pending requests list, and offer only decisions that row lists. accept allows it " +
          "once, accept_for_session for the rest of the session, accept_always from now on; " +
          "decline refuses and lets the agent continue; cancel refuses and stops the turn.",
      fields =
        listOf(
          environmentId,
          threadId,
          requestId,
          Field.Choice(
            "decision",
            "The answer.",
            listOf("accept", "accept_for_session", "accept_always", "decline", "cancel")
          ),
        ),
      required = listOf("environmentId", "threadId", "requestId", "decision"),
    )

  val answerQuestion =
    write(
      AssistantOperation.ANSWER_QUESTION,
      title = "Answer a T3 Code question",
      description =
        "Answer a question a T3 Code thread asked. Take requestId and the questions from the " +
          "pending requests list. For a single question pass answer: an option's label, or " +
          "free text when the question allows it. For several questions pass answersJson " +
          "instead.",
      fields =
        listOf(
          environmentId,
          threadId,
          requestId,
          Field.Text(
            "answer",
            "Answer to the only question: an option label, several labels separated by commas " +
              "for a multi-select question, or free text.",
            max = MAX_ANSWER_LENGTH,
          ),
          Field.Text(
            "answersJson",
            "JSON object from each question's id to its answer string, or to a list of option " +
              "labels for a multi-select question.",
            max = MAX_ANSWERS_JSON_LENGTH,
          ),
        ),
      required = listOf("environmentId", "threadId", "requestId"),
    ) { arguments ->
      if (arguments.containsKey("answer") == arguments.containsKey("answersJson")) {
        throw InvalidArgumentsException("Pass answer or answersJson")
      }
    }

  val dismissQuestion =
    write(
      AssistantOperation.DISMISS_QUESTION,
      title = "Dismiss a T3 Code question",
      description =
        "Dismiss a question a T3 Code thread asked without answering it, when the pending " +
          "requests list marks it dismissible.",
      fields = listOf(environmentId, threadId, requestId),
      required = listOf("environmentId", "threadId", "requestId"),
    )

  val renameThread =
    write(
      AssistantOperation.RENAME_THREAD,
      title = "Rename a T3 Code thread",
      description = "Change a T3 Code thread's title.",
      fields = listOf(environmentId, threadId, Field.Text("title", "The new title.", max = 200)),
      required = listOf("environmentId", "threadId", "title"),
    )

  val configureThread =
    write(
      AssistantOperation.CONFIGURE_THREAD,
      title = "Change a T3 Code thread's settings",
      description =
        "Change the model, model options, runtime mode, or interaction mode a T3 Code thread " +
          "uses from its next turn. Pass at least one setting. Take provider, model, and " +
          "modelOptions from the models catalog.",
      fields =
        listOf(
          environmentId,
          threadId,
          provider,
          Field.Text(
            "model",
            "Model ID from the T3 Code models catalog for this provider. Without provider, a " +
              "model of the thread's current provider."
          ),
          modelOptions,
          runtimeMode,
          interactionMode,
        ),
      required = listOf("environmentId", "threadId"),
    ) { arguments ->
      val settings = listOf("provider", "model", "modelOptions", "runtimeMode", "interactionMode")
      if (settings.none(arguments::containsKey)) {
        throw InvalidArgumentsException("Pass at least one setting to change")
      }
    }

  val forkThread =
    write(
      AssistantOperation.FORK_THREAD,
      title = "Fork a T3 Code thread",
      description =
        "Start a new T3 Code thread that continues from a thread's latest finished response, " +
          "leaving the original as it is. The receipt's newThreadId is the new thread.",
      fields =
        listOf(
          environmentId,
          threadId,
          Field.Text("title", "Title of the new thread. Defaults to the original's.", max = 200),
        ),
      required = listOf("environmentId", "threadId"),
    )

  val manageQueuedMessage =
    write(
      AssistantOperation.MANAGE_QUEUED_MESSAGE,
      title = "Change a queued T3 Code message",
      description =
        "Remove a message waiting in a T3 Code thread's queue, or steer it into the running " +
          "turn now. Take runId from the queued messages list.",
      fields =
        listOf(
          environmentId,
          threadId,
          Field.Text("runId", "Queued message ID from T3 Code's queued messages list."),
          Field.Choice(
            "action",
            "remove deletes it; steer sends it into the running turn now.",
            listOf("remove", "steer")
          ),
        ),
      required = listOf("environmentId", "threadId", "runId", "action"),
    )

  val requestStatus =
    Capability(
      name = REQUEST_STATUS_CAPABILITY,
      title = "Check a T3 Code request",
      description =
        "Report the current state of an earlier T3 Code action by its invocation ID. " +
          "If that request is still pending, T3 Code continues it under the same idempotency " +
          "key; it never starts a second one.",
      effects = "read",
      maxWaitMillis = 10_000,
      fields = listOf(
        Field.Text(
          "invocationId",
          "The invocation ID of the earlier action.",
          max = 256
        )
      ),
      required = listOf("invocationId"),
    )

  val all =
    listOf(
      startThread,
      sendMessage,
      interruptThread,
      organizeThread,
      respondToApproval,
      answerQuestion,
      dismissQuestion,
      renameThread,
      configureThread,
      forkThread,
      manageQueuedMessage,
      requestStatus,
    )

  fun byName(name: String): Capability? = all.firstOrNull { it.name == name }
}
