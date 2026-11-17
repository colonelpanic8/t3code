package expo.modules.t3androidintents

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AndroidIntentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AndroidIntents")
    // Reopening from recents replays the original launch intent, links included.
    Function("isLaunchedFromHistory") {
      val flags = appContext.currentActivity?.intent?.flags ?: 0
      flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
    }
  }
}
