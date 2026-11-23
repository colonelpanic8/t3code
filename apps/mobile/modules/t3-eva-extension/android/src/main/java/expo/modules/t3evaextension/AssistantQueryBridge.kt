package expo.modules.t3evaextension

import android.content.Context
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Carries one assistant query from a binder thread to JavaScript and back.
 * The message and model tables have to be live, and only JavaScript can reach the environment,
 * so [AssistantContentProvider] runs a headless task through
 * [AssistantRuntime] and parks its binder thread here until the task answers
 * or the wait runs out. A cold process starts React Native to answer.
 */
object AssistantQueryBridge {
  private val pending = ConcurrentHashMap<String, ArrayBlockingQueue<String>>()

  /**
   * Null when the runtime cannot start, cannot reach the host, or runs out of time. The task
   * gets the wall-clock time this wait ends, so a cold start spends whatever is left of it
   * connecting instead of a fixed share.
   */
  fun request(context: Context, kind: String, params: Map<String, Any?>, timeoutMs: Long): String? {
    val requestId = UUID.randomUUID().toString()
    val answers = ArrayBlockingQueue<String>(1)
    pending[requestId] = answers
    return try {
      AssistantRuntime.startTask(
        context,
        mapOf(
          "kind" to kind,
          "requestId" to requestId,
          "params" to JSONObject(params).toString(),
          "deadlineAt" to (System.currentTimeMillis() + timeoutMs).toString(),
        ),
      )
      answers.poll(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      null
    } catch (_: Exception) {
      null
    } finally {
      pending.remove(requestId)
    }
  }

  fun resolve(requestId: String, json: String) {
    pending[requestId]?.offer(json)
  }
}
