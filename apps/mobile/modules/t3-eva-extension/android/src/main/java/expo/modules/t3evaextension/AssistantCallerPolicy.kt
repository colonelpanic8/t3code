package expo.modules.t3evaextension

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import expo.modules.t3evaextension.assistant.CallerRules

// Public signing certificate of the released EVA app, not a secret.
private const val EVA_CERT_SHA256 =
  "688df17827dd9a002705baf0400c80f8f4650c6e87c3fc91d41f32be287f8b68"

/** Android side of [CallerRules]: where the caller's identity and this build's trust come from. */
object AssistantCallerPolicy {
  /** For binder entry points without a framework-verified calling package. */
  fun isAuthorizedUid(context: Context, uid: Int): Boolean {
    val packages = context.packageManager.getPackagesForUid(uid)?.toList() ?: return false
    return allows(context, uid, packages)
  }

  /** For content provider calls, whose calling package the framework has verified. */
  fun isAuthorized(
    context: Context,
    uid: Int,
    packageName: String
  ): Boolean = allows(context, uid, listOf(packageName))

  private fun allows(context: Context, uid: Int, packages: List<String>): Boolean {
    val manager = context.packageManager
    return CallerRules.allows(
      callerPackages = packages,
      // Only a debuggable build trusts debug EVA, and only when it shares this build's signer.
      debugCallersAllowed = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
      hasReleaseCertificate = {
        val certificate = EVA_CERT_SHA256.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        manager.hasSigningCertificate(uid, certificate, PackageManager.CERT_INPUT_SHA256)
      },
      sharesSigner = {
        manager.checkSignatures(context.applicationInfo.uid, uid) ==
          PackageManager.SIGNATURE_MATCH
      },
    )
  }
}
