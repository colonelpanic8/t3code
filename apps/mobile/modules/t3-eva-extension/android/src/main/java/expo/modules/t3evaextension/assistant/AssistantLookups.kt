package expo.modules.t3evaextension.assistant

const val MAX_CATALOG_OFFSET = 1_000L

class AssistantLookup(val table: String, val capability: Capability)

object AssistantLookups {
  private val environment = Field.Text(
    "environmentId",
    "Environment ID returned by list_environments."
  )
  private val project = Field.Text(
    "projectId",
    "Project ID returned by list_projects in this environment."
  )
  private val thread = Field.Text(
    "threadId",
    "Thread ID returned by list_threads in this environment."
  )
  private val query = Field.Text(
    "q",
    "Case-insensitive search text. Omit to list all matches.",
    max = 500
  )
  private val limit = Field.Whole("limit", "Maximum rows, 1 to 100; defaults to 25.", 1, 100)
  private val offset = Field.Whole(
    "offset",
    "Rows to skip, for the next page: pass the previous reply's nextOffset with the same filters.",
    0,
    MAX_CATALOG_OFFSET
  )
  private val activity = Field.Choice(
    "activity",
    "working: a turn is running or queued; needs_input: waiting on an approval or question; " +
      "idle: no active turn (status is how the last turn ended). Omit to list every open thread.",
    ThreadActivity.values
  )

  private fun lookup(
    name: String,
    table: String,
    description: String,
    fields: List<Field>,
    required: List<String> = emptyList()
  ) = AssistantLookup(
    table,
    Capability(
      name = name,
      title = name.replace('_', ' '),
      description = "$description Use returned IDs exactly; IDs belong to their environment. " +
        "Rows are in the structured data. Before calling a list complete, check complete: when " +
        "false, incompleteReasons and the text say what is missing, and nextOffset fetches the " +
        "next page. Notice rows mean unavailable data, not an empty result.",
      effects = "read",
      maxWaitMillis = 25_000,
      fields = fields,
      required = required,
    )
  )

  val all = listOf(
    lookup(
      "list_environments",
      "environments",
      "Find configured T3 Code environments by name or ID. Reads the app's cached catalog; " +
        "open T3 Code to refresh missing or stale entries.",
      listOf(query, limit, offset)
    ),
    lookup(
      "list_projects",
      "projects",
      "Find projects by name, repository, path, or ID, " +
        "optionally in one environment. " +
        "Reads the app's cached catalog; open T3 Code to refresh it.",
      listOf(environment, query, limit, offset)
    ),
    lookup(
      "list_threads",
      "threads",
      "List open (unarchived) threads, most recent activity first, optionally by environment, " +
        "project, activity, or title/branch/ID text. For running threads pass activity=working; " +
        "for every open thread omit it and page with nextOffset until complete is true. " +
        "Archived threads are not listed. Reads the cached catalog plus recently created " +
        "threads; use get_thread_status for live state.",
      listOf(environment, project, activity, query, limit, offset)
    ),
    lookup(
      "read_messages",
      "messages",
      "Read a thread's recent messages live.",
      listOf(
        environment,
        thread,
        Field.Whole("limit", "Maximum messages, 1 to 50; defaults to 10.", 1, 50)
      ),
      listOf("environmentId", "threadId")
    ),
    lookup(
      "list_models",
      "models",
      "Read live providers, models, and supported options before selecting a model for new work or fanout.",
      listOf(environment, Field.Text("provider", "Provider instance ID to filter."), query, limit),
      listOf("environmentId")
    ),
    lookup(
      "list_requests",
      "requests",
      "Read pending approvals and questions live. Without environmentId, queries all enabled " +
        "environments and reports failures separately. Use returned decisions and question IDs to answer.",
      listOf(environment, thread, limit)
    ),
    lookup(
      "get_thread_status",
      "thread_status",
      "Read live run status, queued count, pending requests, model settings, " +
        "and last assistant response. A row with status=notice means T3 Code could not read " +
        "the thread right now (its note says why), not that the thread is gone or idle. " +
        "Use this to track work after start_thread or send_message; request_status only tracks delivery.",
      listOf(environment, thread),
      listOf("environmentId", "threadId")
    ),
    lookup(
      "list_queued_messages",
      "queue",
      "Read a thread's queued messages and run IDs live.",
      listOf(environment, thread, limit),
      listOf("environmentId", "threadId")
    ),
  )

  fun byName(name: String): AssistantLookup? = all.firstOrNull { it.capability.name == name }
}
