package expo.modules.t3evaextension

import android.content.Context
import android.os.SystemClock
import expo.modules.t3evaextension.assistant.AssistantJournal
import expo.modules.t3evaextension.assistant.AssistantRequestEntry
import expo.modules.t3evaextension.assistant.ReceiptState
import expo.modules.t3evaextension.assistant.ReceiptUpdate
import expo.modules.t3evaextension.assistant.StrictJson
import java.io.File
import java.util.concurrent.ConcurrentHashMap

private const val JOURNAL_DIR = "assistant-requests"
private const val GRANT_PREFS = "t3code-assistant-automation"
private const val GRANT_KEY = "evaMayRunThreads"

// A Headless JS task that neither reports nor finishes in this long is presumed dead.
private const val JOB_STALE_MS = 120_000L

/**
 * Connects journaled assistant requests to the JavaScript executor. The
 * journal is the source of truth; this only tracks which requests a live task
 * is already working on, so a status poll resumes a request at most once.
 */
object AssistantJobs {
  private val active = ConcurrentHashMap<String, Long>()

  @Volatile
  private var journal: AssistantJournal? = null

  fun journal(context: Context): AssistantJournal =
    journal ?: synchronized(this) {
      journal
        ?: AssistantJournal(File(context.applicationContext.filesDir, JOURNAL_DIR)).also {
          journal =
            it
        }
    }

  // On unless the user turned it off: only the verified EVA caller reaches it.
  fun isUnattendedAllowed(context: Context): Boolean =
    context.applicationContext.getSharedPreferences(
      GRANT_PREFS,
      Context.MODE_PRIVATE
    ).getBoolean(GRANT_KEY, true)

  fun setUnattendedAllowed(context: Context, allowed: Boolean) {
    context.applicationContext.getSharedPreferences(GRANT_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(GRANT_KEY, allowed)
      .commit()
  }

  /**
   * Hands a pending request to JavaScript unless a live task already has it.
   * Closes the request as not started when there is no runtime to run it.
   */
  @Suppress("ReturnCount", "TooGenericExceptionCaught")
  fun ensureRunning(context: Context, entry: AssistantRequestEntry) {
    if (!entry.isPending) return
    val now = SystemClock.elapsedRealtime()
    val previous = active.putIfAbsent(entry.key, now)
    if (previous != null) {
      if (now - previous < JOB_STALE_MS) return
      if (!active.replace(entry.key, previous, now)) return
    }
    val data =
      mapOf(
        "kind" to "request",
        "key" to entry.key,
        "operation" to entry.operation.wire,
        "arguments" to StrictJson.stringify(entry.arguments),
        "plan" to (entry.plan?.let(StrictJson::stringify) ?: ""),
        "dispatchStarted" to entry.dispatchStarted.toString(),
      )
    try {
      AssistantRuntime.startTask(context, data)
    } catch (error: Exception) {
      active.remove(entry.key)
      journal(context).update(
        entry.key,
        ReceiptUpdate(
          state = ReceiptState.NOT_STARTED,
          errorCode = "runtime_unavailable",
          errorMessage = error.message ?: "T3 Code could not start its background runtime.",
        ),
      )
    }
  }

  fun report(context: Context, key: String, json: String): String? {
    active.computeIfPresent(key) { _, _ -> SystemClock.elapsedRealtime() }
    val update = ReceiptUpdate.fromJson(StrictJson.parseObject(json))
    val entry = journal(context).update(key, update) ?: return null
    return StrictJson.stringify(entry.toJson())
  }

  fun finish(key: String) {
    active.remove(key)
  }
}
