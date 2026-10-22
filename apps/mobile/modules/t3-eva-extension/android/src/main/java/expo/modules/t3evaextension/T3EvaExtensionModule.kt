package expo.modules.t3evaextension

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Stores the assistant catalog and carries the headless assistant task's
 * answers and progress back to native code.
 */
class T3EvaExtensionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3EvaExtension")

    Function("publishAssistantCatalog") { json: String ->
      AssistantCatalogStore.write(requireContext(), json)
    }

    Function("resolveAssistantQuery") { requestId: String, json: String ->
      AssistantQueryBridge.resolve(requestId, json)
    }

    // Awaited by the executor before it sends, so the journal records a
    // dispatch before the environment can see it. Returns the stored request.
    AsyncFunction("reportAssistantRequest") { key: String, json: String ->
      AssistantJobs.report(requireContext(), key, json)
    }

    Function("finishAssistantRequest") { key: String ->
      AssistantJobs.finish(key)
    }

    Function("isAssistantAutomationAllowed") {
      AssistantJobs.isUnattendedAllowed(requireContext())
    }

    Function("setAssistantAutomationAllowed") { allowed: Boolean ->
      AssistantJobs.setUnattendedAllowed(requireContext(), allowed)
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: error("React context is not available")
}
