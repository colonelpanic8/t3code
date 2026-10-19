package expo.modules.t3evaextension.assistant

class InvalidArgumentsException(message: String) : IllegalArgumentException(message)

enum class AssistantOperation(val wire: String) {
  START_THREAD("start_thread"),
  SEND_MESSAGE("send_message")
  ;

  companion object {
    fun fromWire(value: String): AssistantOperation? = entries.firstOrNull { it.wire == value }
  }
}

const val REQUEST_STATUS_CAPABILITY = "request_status"
const val MAX_PROMPT_LENGTH = 16_000

private const val ID_MAX = 200

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
}

@Suppress("LongParameterList")
class Capability(
  val name: String,
  val title: String,
  val description: String,
  val effects: String,
  val maxWaitMillis: Long,
  val fields: List<Field>,
  val required: List<String>
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
    return result
  }
}

private val environmentId =
  Field.Text("environmentId", "Environment ID from the T3 Code projects or threads catalog.")
private val prompt = Field.Text("prompt", "The message to send.", max = MAX_PROMPT_LENGTH)

private const val PENDING_HINT =
  "accepted, submitted, or waiting_for_host mean T3 Code is still working on it: call " +
    "request_status " +
    "with this invocation's ID instead of calling it again."

object AssistantCapabilities {
  val startThread =
    Capability(
      name = AssistantOperation.START_THREAD.wire,
      title = "Start a T3 Code thread",
      description =
        "Start a new coding thread in a T3 Code project with an initial prompt. " +
          "Use environmentId and projectId exactly as listed by the T3 Code projects catalog. " +
          "state=completed means the thread exists and received the prompt, not that its task " +
          "is done. " +
          "The receipt names the environment as environmentName and the new thread as threadId. " +
          PENDING_HINT,
      effects = "write",
      maxWaitMillis = 25_000,
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
            "local (default) works in the project directory; worktree starts the thread in a " +
              "new git worktree.",
            listOf("local", "worktree"),
          ),
          Field.Text(
            "baseBranch",
            "Only with workspace=worktree: branch the worktree starts from. Defaults to the " +
              "project's current branch.",
            max = 300,
          ),
        ),
      required = listOf("environmentId", "projectId", "prompt"),
    )

  val sendMessage =
    Capability(
      name = AssistantOperation.SEND_MESSAGE.wire,
      title = "Send a message to a T3 Code thread",
      description =
        "Send a message to an existing T3 Code thread. Use environmentId and threadId from the " +
          "T3 Code threads catalog. " +
          "state=completed means the thread accepted the message. " +
          PENDING_HINT,
      effects = "write",
      maxWaitMillis = 25_000,
      fields =
        listOf(
          environmentId,
          Field.Text(
            "threadId",
            "Thread ID from the T3 Code threads catalog, for the same environmentId."
          ),
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

  val requestStatus =
    Capability(
      name = REQUEST_STATUS_CAPABILITY,
      title = "Check a T3 Code request",
      description =
        "Report the current state of an earlier start_thread or send_message call by its " +
          "invocation ID. " +
          "If that request is still pending, T3 Code continues it under the same idempotency " +
          "key; it never starts a second one.",
      effects = "read",
      maxWaitMillis = 10_000,
      fields = listOf(
        Field.Text(
          "invocationId",
          "The invocation ID of the earlier start_thread or send_message call.",
          max = 256
        )
      ),
      required = listOf("invocationId"),
    )

  val all = listOf(startThread, sendMessage, requestStatus)

  fun byName(name: String): Capability? = all.firstOrNull { it.name == name }

  /** Field combinations the flat schema cannot express. */
  fun checkCombination(arguments: Map<String, Any?>) {
    if (arguments.containsKey("baseBranch") && arguments["workspace"] != "worktree") {
      throw InvalidArgumentsException("baseBranch requires workspace=worktree")
    }
    if (arguments.containsKey("model") && !arguments.containsKey("provider")) {
      throw InvalidArgumentsException("model requires provider")
    }
  }
}
