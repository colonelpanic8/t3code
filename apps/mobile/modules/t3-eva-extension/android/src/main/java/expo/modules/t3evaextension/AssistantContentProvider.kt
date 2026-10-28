package expo.modules.t3evaextension

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.CancellationSignal

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
    return AssistantQueries(requireNotNull(context)).query(uri, projection)
  }

  @Suppress("ReturnCount")
  private fun isAuthorizedCaller(): Boolean {
    val appContext = context ?: return false
    val caller = callingPackage ?: return false
    return AssistantCallerPolicy.isAuthorized(appContext, Binder.getCallingUid(), caller)
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
