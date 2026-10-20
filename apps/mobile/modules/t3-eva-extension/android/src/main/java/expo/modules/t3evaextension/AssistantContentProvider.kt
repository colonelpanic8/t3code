package expo.modules.t3evaextension

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Binder
import android.os.CancellationSignal
import expo.modules.t3evaextension.assistant.CreatedCatalogRows
import expo.modules.t3evaextension.assistant.parseIsoTimestamp
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private const val DEFAULT_LIMIT = 25
private const val MAX_LIMIT = 100
private const val MESSAGE_DEFAULT_LIMIT = 10
private const val MESSAGE_MAX_LIMIT = 50

// Creations older than this are in any catalog published since; skip their journal files.
private const val CREATED_ROWS_MAX_AGE_MS = 24 * 60 * 60 * 1000L

// Leaves room for a cold React Native start and an environment round trip.
private const val LIVE_TIMEOUT_MS = 17_000L
private const val MESSAGE_UNAVAILABLE_NOTICE =
  "T3 Code could not read the thread in time; ask again in a moment."
private const val MODEL_UNAVAILABLE_NOTICE =
  "T3 Code could not read that environment's models in time; ask again in a moment."
private const val LIVE_UNAVAILABLE_NOTICE =
  "T3 Code could not reach its environments in time; ask again in a moment."

private val ENVIRONMENT_COLUMNS = listOf("id", "name", "connected", "status")
private val PROJECT_COLUMNS =
  listOf("id", "environmentId", "environmentName", "name", "workspaceRoot", "repository")
private val THREAD_COLUMNS =
  listOf(
    "id",
    "environmentId",
    "environmentName",
    "projectId",
    "projectName",
    "title",
    "branch",
    "worktreePath",
    "provider", "model", "status", "lastActivityAt",
  )
private val MESSAGE_COLUMNS =
  listOf(
    "id",
    "environmentId",
    "environmentName",
    "threadId",
    "threadTitle",
    "role",
    "createdAt",
    "text"
  )
private val MODEL_COLUMNS =
  listOf(
    "environmentId",
    "environmentName",
    "provider",
    "providerLabel",
    "status",
    "model",
    "modelLabel",
    "isDefault",
    "options",
    "note",
  )
private val REQUEST_COLUMNS =
  listOf(
    "requestId",
    "environmentId",
    "environmentName",
    "threadId",
    "threadTitle",
    "kind",
    "requestKind",
    "createdAt",
    "detail",
    "decisions",
    "questions",
    "answerable",
    "dismissible",
  )
private val STATUS_COLUMNS =
  listOf(
    "id",
    "environmentId",
    "environmentName",
    "projectId",
    "projectName",
    "title",
    "status",
    "activeRunStatus",
    "queuedCount",
    "pendingApprovals",
    "pendingQuestions",
    "branch",
    "worktreePath",
    "provider",
    "model",
    "modelOptions",
    "runtimeMode",
    "interactionMode",
    "pinned",
    "archived",
    "settled",
    "snoozedUntil",
    "lastActivityAt",
    "lastAssistantMessage",
    "note",
  )
private val QUEUE_COLUMNS =
  listOf(
    "runId",
    "environmentId",
    "environmentName",
    "threadId",
    "threadTitle",
    "position",
    "text",
    "held",
    "canSteer",
  )
private val INT_COLUMNS =
  setOf(
    "connected",
    "isDefault",
    "answerable",
    "dismissible",
    "queuedCount",
    "pendingApprovals",
    "pendingQuestions",
    "pinned",
    "archived",
    "settled",
    "position",
    "held",
    "canSteer",
  )

/** Live tables answered by JavaScript: query parameters each takes and the one it needs. */
private class LiveTable(
  val columns: List<String>,
  val params: Set<String>,
  val required: String?,
  val defaultLimit: Int,
  val maxLimit: Int,
  val notice: (Map<String, Any?>) -> Map<String, Any?>
)

private val LIVE_TABLES =
  mapOf(
    "requests" to
      LiveTable(
        REQUEST_COLUMNS,
        setOf("environmentId", "threadId", "limit"),
        required = null,
        defaultLimit = DEFAULT_LIMIT,
        maxLimit = MAX_LIMIT,
      ) { params ->
        mapOf(
          "requestId" to "notice",
          "environmentId" to (params["environmentId"] ?: ""),
          "threadId" to (params["threadId"] ?: ""),
          "kind" to "notice",
          "detail" to LIVE_UNAVAILABLE_NOTICE,
        )
      },
    "thread_status" to
      LiveTable(
        STATUS_COLUMNS,
        setOf("environmentId", "threadId"),
        required = "threadId",
        defaultLimit = 1,
        maxLimit = 1,
      ) { params ->
        mapOf(
          "id" to params["threadId"],
          "environmentId" to (params["environmentId"] ?: ""),
          "status" to "notice",
          "note" to LIVE_UNAVAILABLE_NOTICE,
        )
      },
    "queue" to
      LiveTable(
        QUEUE_COLUMNS,
        setOf("environmentId", "threadId", "limit"),
        required = "threadId",
        defaultLimit = DEFAULT_LIMIT,
        maxLimit = MAX_LIMIT,
      ) { params ->
        mapOf(
          "runId" to "notice",
          "environmentId" to (params["environmentId"] ?: ""),
          "threadId" to params["threadId"],
          "text" to LIVE_UNAVAILABLE_NOTICE,
        )
      },
  )

// Which query parameters filter which catalog table.
private val CATALOG_FILTERS =
  mapOf(
    "environments" to setOf("q", "limit"),
    "projects" to setOf("environmentId", "q", "limit"),
    "threads" to setOf("environmentId", "projectId", "q", "limit"),
  )

/**
 * Read-only view of what T3 Code knows, for on-device assistants that can
 * query a content provider but not run code here.
 * `content://<authority>/environments`, `/projects?environmentId=&q=&limit=` and
 * `/threads?environmentId=&projectId=&q=&limit=` are served from the file
 * [AssistantCatalogStore] holds, so they answer without starting React Native.
 * `/messages?threadId=&environmentId=&limit=` needs a live transcript, and
 * `/models?environmentId=&provider=&q=&limit=` the environment's live provider
 * list, `/requests?environmentId=&threadId=&limit=` the pending approvals and
 * questions, `/thread_status?threadId=&environmentId=` one thread's live state,
 * and `/queue?threadId=&environmentId=&limit=` its queued messages; all go
 * through [AssistantQueryBridge], which starts the JavaScript
 * runtime headless when the app is not running. Only query parameters filter:
 * a SQL selection is refused rather than ignored.
 */
class AssistantContentProvider : ContentProvider() {
  private var authority: String = ""

  override fun attachInfo(context: Context, info: ProviderInfo) {
    super.attachInfo(context, info)
    authority = info.authority
  }

  override fun onCreate(): Boolean = true

  override fun getType(uri: Uri): String? =
    when (uri.pathSegments.singleOrNull()) {
      "environments" -> "vnd.android.cursor.dir/vnd.$authority.environment"
      "projects" -> "vnd.android.cursor.dir/vnd.$authority.project"
      "threads" -> "vnd.android.cursor.dir/vnd.$authority.thread"
      "messages" -> "vnd.android.cursor.dir/vnd.$authority.message"
      "models" -> "vnd.android.cursor.dir/vnd.$authority.model"
      "requests" -> "vnd.android.cursor.dir/vnd.$authority.request"
      "thread_status" -> "vnd.android.cursor.dir/vnd.$authority.thread_status"
      "queue" -> "vnd.android.cursor.dir/vnd.$authority.queued_message"
      else -> null
    }

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
    cancellationSignal: CancellationSignal?
  ): Cursor = query(uri, projection, selection, selectionArgs, sortOrder)

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?
  ): Cursor {
    if (!isAuthorizedCaller()) {
      throw SecurityException("Caller is not an allowed assistant")
    }
    require(uri.authority == authority) { "Unknown authority ${uri.authority}" }
    require(selection.isNullOrEmpty() && selectionArgs.isNullOrEmpty()) {
      "Filter with query parameters; selections are not supported"
    }
    require(sortOrder.isNullOrEmpty()) { "Sorting is fixed to most recent activity" }
    val table =
      uri.pathSegments.singleOrNull()
        ?: throw IllegalArgumentException("Unknown table ${uri.path}")
    return when (table) {
      "environments" -> queryCatalog("environments", ENVIRONMENT_COLUMNS, uri, projection)
      "projects" -> queryCatalog("projects", PROJECT_COLUMNS, uri, projection)
      "threads" -> queryCatalog("threads", THREAD_COLUMNS, uri, projection)
      "messages" -> queryMessages(uri, projection)
      "models" -> queryModels(uri, projection)
      else -> {
        val live = LIVE_TABLES[table] ?: throw IllegalArgumentException("Unknown table ${uri.path}")
        queryLive(table, live, uri, projection)
      }
    }
  }

  @Suppress("ReturnCount")
  private fun isAuthorizedCaller(): Boolean {
    val appContext = context ?: return false
    val caller = callingPackage ?: return false
    return AssistantCallerPolicy.isAuthorized(appContext, Binder.getCallingUid(), caller)
  }

  private fun queryCatalog(
    table: String,
    columns: List<String>,
    uri: Uri,
    projection: Array<String>?
  ): Cursor {
    val requested = requestedColumns(projection, columns)
    val allowed = CATALOG_FILTERS.getValue(table)
    val stray = uri.queryParameterNames.firstOrNull { it !in allowed }
    require(stray == null) { "$stray does not filter $table" }
    val limit = parseLimit(uri.getQueryParameter("limit"), DEFAULT_LIMIT, MAX_LIMIT)
    val query = param(uri, "q")?.lowercase()
    val environmentId = param(uri, "environmentId")
    val projectId = param(uri, "projectId")

    val catalog = readCatalog()
    val published = catalog?.optJSONArray(table).toList()
    val rows =
      (createdRows(table, catalog, published) + published).filter { row ->
        (environmentId == null || row.optString("environmentId") == environmentId) &&
          (projectId == null || row.optString("projectId") == projectId) &&
          (
            query == null ||
              columns.any { column -> row.optString(column).lowercase().contains(query) }
            )
      }
    return cursorOf(requested, rows, limit)
  }

  /**
   * Asks the running app for the newest messages. Anything that keeps the app
   * from answering is a single notice row, not an exception: an assistant can
   * read a sentence out loud but cannot act on a failed query.
   */
  private fun queryMessages(uri: Uri, projection: Array<String>?): Cursor {
    val requested = requestedColumns(projection, MESSAGE_COLUMNS)
    val threadId = requireNotNull(param(uri, "threadId")) { "Pass threadId" }
    val environmentId = param(uri, "environmentId")
    val limit = parseLimit(uri.getQueryParameter("limit"), MESSAGE_DEFAULT_LIMIT, MESSAGE_MAX_LIMIT)
    val params = mapOf("threadId" to threadId, "environmentId" to environmentId, "limit" to limit)
    val rows =
      context?.let {
        AssistantQueryBridge.request(it, "messages", params, LIVE_TIMEOUT_MS)
      }?.let(::parseRows)
        ?: listOf(
          JSONObject(
            mapOf(
              "id" to "notice",
              "environmentId" to (environmentId ?: ""),
              "threadId" to threadId,
              "role" to "notice",
              "text" to MESSAGE_UNAVAILABLE_NOTICE,
            ),
          ),
        )
    return cursorOf(requested, rows, limit)
  }

  /** The environment's live provider list, one row per model; failures are a single notice row. */
  private fun queryModels(uri: Uri, projection: Array<String>?): Cursor {
    val requested = requestedColumns(projection, MODEL_COLUMNS)
    val environmentId = requireNotNull(param(uri, "environmentId")) { "Pass environmentId" }
    val limit = parseLimit(uri.getQueryParameter("limit"), DEFAULT_LIMIT, MAX_LIMIT)
    val params =
      mapOf(
        "environmentId" to environmentId,
        "provider" to param(uri, "provider"),
        "q" to param(uri, "q"),
        "limit" to limit
      )
    val rows =
      context?.let {
        AssistantQueryBridge.request(it, "models", params, LIVE_TIMEOUT_MS)
      }?.let(::parseRows)
        ?: listOf(
          JSONObject(
            mapOf(
              "environmentId" to environmentId,
              "status" to "notice",
              "note" to MODEL_UNAVAILABLE_NOTICE
            )
          )
        )
    return cursorOf(requested, rows, limit)
  }

  /** A live table through JavaScript; anything that keeps it from answering is one notice row. */
  private fun queryLive(
    table: String,
    live: LiveTable,
    uri: Uri,
    projection: Array<String>?
  ): Cursor {
    val requested = requestedColumns(projection, live.columns)
    val stray = uri.queryParameterNames.firstOrNull { it !in live.params }
    require(stray == null) { "$stray does not filter $table" }
    live.required?.let { name -> requireNotNull(param(uri, name)) { "Pass $name" } }
    val limit = parseLimit(uri.getQueryParameter("limit"), live.defaultLimit, live.maxLimit)
    val params = HashMap<String, Any?>()
    for (name in live.params - "limit") params[name] = param(uri, name)
    params["limit"] = limit
    val rows =
      context?.let {
        AssistantQueryBridge.request(it, table, params, LIVE_TIMEOUT_MS)
      }?.let(::parseRows)
        ?: listOf(JSONObject(live.notice(params)))
    return cursorOf(requested, rows, limit)
  }

  private fun cursorOf(requested: List<String>, rows: List<JSONObject>, limit: Int): Cursor {
    val cursor = MatrixCursor(requested.toTypedArray(), minOf(rows.size, limit))
    for (row in rows.take(limit)) {
      cursor.addRow(
        requested.map { column ->
          when {
            column in INT_COLUMNS -> row.optInt(column)
            row.isNull(column) -> null
            else -> row.optString(column)
          }
        },
      )
    }
    return cursor
  }

  private fun param(uri: Uri, name: String): String? = uri.getQueryParameter(
    name
  )?.trim()?.ifEmpty {
    null
  }

  private fun parseRows(json: String): List<JSONObject>? =
    try {
      JSONObject(json).optJSONArray("rows")?.toList()
    } catch (_: JSONException) {
      null
    }

  private fun requestedColumns(projection: Array<String>?, columns: List<String>): List<String> {
    val requested = projection?.toList() ?: columns
    val unknown = requested.filterNot { it in columns }
    require(unknown.isEmpty()) { "Unknown columns ${unknown.joinToString()}" }
    return requested
  }

  private fun parseLimit(raw: String?, default: Int, max: Int): Int {
    if (raw == null) return default
    val limit = raw.toIntOrNull()
    require(limit != null && limit in 1..max) { "limit must be 1..$max" }
    return limit
  }

  /**
   * Threads assistant requests created since the catalog was captured and it
   * does not list yet, ahead of the published rows because they are newer.
   */
  @Suppress("ReturnCount")
  private fun createdRows(
    table: String,
    catalog: JSONObject?,
    published: List<JSONObject>
  ): List<JSONObject> {
    val context = context ?: return emptyList()
    val capturedAtMs = catalog?.optString("capturedAt")?.let(::parseIsoTimestamp)
    val since = maxOf(capturedAtMs ?: 0L, System.currentTimeMillis() - CREATED_ROWS_MAX_AGE_MS)
    val entries = AssistantJobs.journal(context).creationsSince(since)
    if (entries.isEmpty()) return emptyList()
    val listed = published.mapTo(HashSet()) { it.optString("environmentId") to it.optString("id") }
    return CreatedCatalogRows.rows(table, entries, listed, capturedAtMs).map { JSONObject(it) }
  }

  @Suppress("ReturnCount")
  private fun readCatalog(): JSONObject? {
    val context = context ?: return null
    val json = AssistantCatalogStore.read(context) ?: return null
    return try {
      JSONObject(json)
    } catch (_: JSONException) {
      null
    }
  }

  private fun JSONArray?.toList(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optJSONObject(it) }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException(
    "read-only"
  )

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<String>?
  ): Int =
    throw UnsupportedOperationException("read-only")

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int =
    throw UnsupportedOperationException("read-only")
}
