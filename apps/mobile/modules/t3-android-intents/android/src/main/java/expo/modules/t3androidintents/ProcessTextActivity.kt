package expo.modules.t3androidintents

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle

/**
 * Turns selected or shared text into a `<scheme>://new?prompt=` link so it takes
 * the same sanitize-and-review path as any other prompt link.
 */
class ProcessTextActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val text = promptText(intent)
    val scheme = appLinkScheme()
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (!text.isNullOrEmpty() && scheme != null && launch != null) {
      startActivity(
        Intent(Intent.ACTION_VIEW, newThreadUri(scheme, text))
          .setComponent(launch.component)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      )
    }
    finish()
  }

  private fun promptText(intent: Intent): String? {
    if (intent.action != Intent.ACTION_SEND) {
      return intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim()
    }
    // A shared link often arrives with the page title as its subject.
    return listOfNotNull(
      intent.getStringExtra(Intent.EXTRA_SUBJECT),
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
    ).map(String::trim).filter(String::isNotEmpty).distinct().joinToString("\n\n").ifEmpty { null }
  }

  private fun appLinkScheme(): String? =
    packageManager
      .getApplicationInfo(packageName, PackageManager.GET_META_DATA)
      .metaData
      ?.getString(APP_LINK_SCHEME_KEY)

  companion object {
    const val APP_LINK_SCHEME_KEY = "com.t3tools.APP_LINK_SCHEME"

    fun newThreadUri(scheme: String, prompt: String): Uri =
      Uri.Builder().scheme(scheme).authority("new").appendQueryParameter("prompt", prompt).build()
  }
}
