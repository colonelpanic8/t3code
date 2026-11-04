package expo.modules.t3evaextension.assistant

/**
 * What a lookup's rows cover, so a reply can say whether it is complete and
 * how to get the rest. Catalog tables know how many rows matched; live tables
 * only know what JavaScript returned.
 */
data class LookupScope(
  val source: String,
  val offset: Long = 0,
  /** Rows matching the filters before offset and limit; null when unknown. */
  val matched: Long? = null,
  val catalogAvailable: Boolean = true,
  val catalogCapturedAt: String? = null,
  /** Rows the published catalog itself left out because of its size cap. */
  val catalogOmitted: Long = 0,
  /** In-scope environments that were not connected when the catalog was captured. */
  val staleEnvironments: List<Map<String, Any?>> = emptyList()
) {
  fun toMap(): Map<String, Any?> =
    linkedMapOf(
      "source" to source,
      "offset" to offset,
      "matched" to matched,
      "catalogAvailable" to catalogAvailable,
      "catalogCapturedAt" to catalogCapturedAt,
      "catalogOmitted" to catalogOmitted,
      "staleEnvironments" to staleEnvironments,
    )

  companion object {
    const val CATALOG = "catalog"
    const val LIVE = "live"

    val live = LookupScope(LIVE)

    @Suppress("UNCHECKED_CAST")
    fun fromMap(map: Map<String, Any?>): LookupScope =
      LookupScope(
        source = map["source"] as? String ?: LIVE,
        offset = map["offset"] as? Long ?: 0,
        matched = map["matched"] as? Long,
        catalogAvailable = map["catalogAvailable"] as? Boolean ?: true,
        catalogCapturedAt = map["catalogCapturedAt"] as? String,
        catalogOmitted = map["catalogOmitted"] as? Long ?: 0,
        staleEnvironments =
          (map["staleEnvironments"] as? List<*>).orEmpty().filterIsInstance<Map<String, Any?>>(),
      )
  }
}

/** Run-state groups for list_threads' `activity` filter, from a catalog row's status. */
object ThreadActivity {
  const val WORKING = "working"
  const val NEEDS_INPUT = "needs_input"
  const val IDLE = "idle"
  val values = listOf(WORKING, NEEDS_INPUT, IDLE)

  private val WORKING_STATUSES = setOf("preparing", "queued", "starting", "running", "waiting")

  fun of(status: String): String =
    when (status) {
      "needs_input" -> NEEDS_INPUT
      in WORKING_STATUSES -> WORKING
      else -> IDLE
    }
}

/** Builds a lookup's structured completeness fields and the sentence EVA reads. */
internal object LookupCoverage {
  const val RESPONSE_SIZE = "response_size"
  const val PAGE_LIMIT = "page_limit"
  const val CATALOG_CAP = "catalog_cap"
  const val NO_CATALOG = "no_catalog"
  const val UNAVAILABLE = "unavailable"

  private val NOUNS =
    mapOf(
      "environments" to "environments",
      "projects" to "projects",
      "threads" to "open threads",
      "messages" to "messages",
      "models" to "models",
      "requests" to "pending requests",
      "thread_status" to "thread status rows",
      "queue" to "queued messages",
    )

  // The column that marks a live table's "could not read this" row.
  private val NOTICE_COLUMNS =
    mapOf(
      "messages" to "role",
      "models" to "status",
      "requests" to "kind",
      "thread_status" to "status",
      "queue" to "runId",
    )

  fun isNotice(table: String, row: Map<String, Any?>): Boolean =
    NOTICE_COLUMNS[table]?.let { row[it] == "notice" } == true

  /**
   * [clipped] is true when the reply budget dropped rows or shortened a value,
   * which the envelope reports as `truncated`; a caller's limit is not truncation.
   */
  @Suppress("CyclomaticComplexMethod")
  fun fields(
    table: String,
    scope: LookupScope,
    rows: List<Map<String, Any?>>,
    clipped: Boolean
  ): Map<String, Any?> {
    val returned = rows.size.toLong()
    val notices = rows.count { isNotice(table, it) }.toLong()
    val pageable = scope.source == LookupScope.CATALOG
    val end = scope.offset + returned
    val more = scope.matched?.let { end < it } ?: false
    val reasons = buildList {
      if (!scope.catalogAvailable) add(NO_CATALOG)
      if (clipped) add(RESPONSE_SIZE)
      if (more && !clipped) add(PAGE_LIMIT)
      if (scope.catalogOmitted > 0) add(CATALOG_CAP)
      if (notices > 0) add(UNAVAILABLE)
    }
    return linkedMapOf(
      "complete" to reasons.isEmpty(),
      "incompleteReasons" to reasons,
      "returned" to returned,
      "matched" to scope.matched,
      "offset" to scope.offset,
      "nextOffset" to if (pageable && more) end else null,
      "unavailableRows" to notices,
      "source" to scope.source,
      "catalogCapturedAt" to scope.catalogCapturedAt,
      "catalogOmitted" to scope.catalogOmitted,
      "staleEnvironments" to scope.staleEnvironments,
    )
  }

  @Suppress("CyclomaticComplexMethod", "LongMethod")
  fun summary(table: String, tool: String?, fields: Map<String, Any?>): String {
    val noun = NOUNS[table] ?: "rows"
    val returned = fields["returned"] as Long
    val matched = fields["matched"] as Long?
    val offset = fields["offset"] as Long
    val nextOffset = fields["nextOffset"] as Long?
    val reasons = (fields["incompleteReasons"] as List<*>).toSet()
    val call = tool ?: "this lookup"
    return buildString {
      if (NO_CATALOG in reasons) {
        append(
          "Not an empty result: T3 Code has not published its catalog on this phone yet. " +
            "Open T3 Code once, then ask again."
        )
        return@buildString
      }
      when {
        matched == null -> append("Returned $returned $noun.")
        matched == 0L -> append("No $noun match.")
        returned == 0L -> append("No $noun at offset $offset; $matched match in total.")
        offset == 0L && returned == matched -> append("All $matched $noun that match.")
        else -> append("Showing $noun ${offset + 1}-${offset + returned} of $matched that match.")
      }
      if (RESPONSE_SIZE in reasons) {
        append(" Incomplete: the reply size limit fit only these rows.")
      } else if (PAGE_LIMIT in reasons) {
        append(" Incomplete: more rows match than the limit allowed.")
      }
      if (nextOffset != null) {
        append(" Call $call again with the same filters and offset=$nextOffset for the rest.")
      } else if (RESPONSE_SIZE in reasons) {
        append(" Narrow the query or lower the limit for the rest.")
      }
      if (CATALOG_CAP in reasons) {
        append(
          " The phone's catalog also leaves out ${fields["catalogOmitted"]} older $noun, which " +
            "no query here can reach."
        )
      }
      if (UNAVAILABLE in reasons) {
        append(
          " ${fields["unavailableRows"]} notice row(s) mean T3 Code could not read live data; " +
            "that is not an empty result. Their text says why."
        )
      }
      val stale = (fields["staleEnvironments"] as List<*>).mapNotNull {
        (it as? Map<*, *>)?.get("name") as? String
      }
      if (stale.isNotEmpty()) {
        append(
          " Not connected when the catalog was captured, so their rows may be stale or " +
            "missing: ${stale.joinToString()}."
        )
      }
      if (fields["source"] == LookupScope.CATALOG) {
        val capturedAt = fields["catalogCapturedAt"] as String?
        append(" From the cached catalog")
        if (capturedAt != null) append(" captured $capturedAt")
        append(".")
        if (table == "threads") {
          append(
            " Lists open (unarchived) threads, most recent activity first; status is the last " +
              "known run state, so use get_thread_status for live state."
          )
        }
      }
      append(" Rows are in the structured data.")
    }
  }
}
