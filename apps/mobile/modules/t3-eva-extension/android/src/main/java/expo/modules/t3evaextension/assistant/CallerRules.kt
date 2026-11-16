package expo.modules.t3evaextension.assistant

const val EVA_PACKAGE = "com.colonelpanic.eva"
const val EVA_DEBUG_PACKAGE = "com.colonelpanic.eva.debug"

/**
 * Who may read transcripts or start threads. Released EVA must carry its pinned
 * certificate. Debug EVA is accepted only by a build that opted into debug
 * callers, and only when it shares this build's signer: a production build
 * never trusts a debug caller, even one signed with a leaked or shared key.
 */
object CallerRules {
  fun allows(
    callerPackages: List<String>,
    debugCallersAllowed: Boolean,
    hasReleaseCertificate: () -> Boolean,
    sharesSigner: () -> Boolean
  ): Boolean {
    // A shared UID would let an untrusted member act with EVA's identity.
    val caller = callerPackages.singleOrNull() ?: return false
    return when (caller) {
      EVA_PACKAGE -> hasReleaseCertificate()
      EVA_DEBUG_PACKAGE -> debugCallersAllowed && sharesSigner()
      else -> false
    }
  }
}
