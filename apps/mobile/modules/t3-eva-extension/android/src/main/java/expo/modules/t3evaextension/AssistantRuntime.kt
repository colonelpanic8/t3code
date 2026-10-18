package expo.modules.t3evaextension

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

private const val TASK_KEY = "T3EvaAssistantTask"
private const val TASK_TIMEOUT_MS = 90_000L

/**
 * Runs assistant work in JavaScript without an Activity. Only JavaScript can
 * talk to an environment (its connection, auth and command correlation), so a
 * cold process starts the React host headless and runs a Headless JS task;
 * a warm process reuses its running host. No screen or component is involved.
 */
object AssistantRuntime {
  /** Throws when this process has no React host to run the task on. */
  fun startTask(context: Context, data: Map<String, String>) {
    val application =
      context.applicationContext as? ReactApplication
        ?: error("Application does not host React Native")
    val host = application.reactHost ?: error("React host is not available")
    UiThreadUtil.runOnUiThread {
      val running = host.currentReactContext
      if (running != null) {
        run(running, data)
        return@runOnUiThread
      }
      host.addReactInstanceEventListener(
        object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            host.removeReactInstanceEventListener(this)
            run(context, data)
          }
        },
      )
      host.start()
    }
  }

  private fun run(context: ReactContext, data: Map<String, String>) {
    UiThreadUtil.runOnUiThread {
      val arguments = Arguments.createMap()
      for ((key, value) in data) arguments.putString(key, value)
      // Allowed in foreground: the same task serves a warm, visible app.
      HeadlessJsTaskContext.getInstance(context)
        .startTask(HeadlessJsTaskConfig(TASK_KEY, arguments, TASK_TIMEOUT_MS, true))
    }
  }
}
