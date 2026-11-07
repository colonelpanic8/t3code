package expo.modules.t3evaextension.assistant

/**
 * Catalog rows for threads that assistant requests created. The app
 * republishes the catalog only while its UI runs, so without these a headless
 * creation stays out of `threads` until T3 Code opens.
 */
object CreatedCatalogRows {
  private val ROW_KEYS = mapOf("threads" to "thread")

  /**
   * How long the app's thread shells may lag a creation. The headless task
   * republishes the catalog as soon as a request completes, often before the
   * environment's shell stream has delivered the new thread.
   */
  const val SHELL_LAG_MS = 60_000L

  /**
   * Newest first. Skips rows the catalog lists, and creations the catalog was
   * captured well after: a catalog that lacks the row by then has seen it
   * archived.
   */
  fun rows(
    table: String,
    entries: List<AssistantRequestEntry>,
    listed: Set<Pair<String, String>>,
    capturedAtMs: Long?
  ): List<Map<String, Any?>> {
    val key = ROW_KEYS[table] ?: return emptyList()
    return entries
      .filter { capturedAtMs == null || capturedAtMs < it.updatedAtMs + SHELL_LAG_MS }
      .sortedByDescending { it.updatedAtMs }
      .mapNotNull { it.createdRow(key) }
      .filter { row ->
        val identity = identity(row)
        identity != null && identity !in listed
      }
      .distinctBy(::identity)
  }

  @Suppress("ReturnCount")
  fun identity(row: Map<String, Any?>): Pair<String, String>? {
    val environmentId = row["environmentId"] as? String ?: return null
    val id = row["id"] as? String ?: return null
    return environmentId to id
  }
}
