package expo.modules.t3evaextension.assistant

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallerRulesTest {
  private fun allows(
    packages: List<String>,
    debugCallersAllowed: Boolean = false,
    releaseCertificate: Boolean = false,
    sharesSigner: Boolean = false
  ) = CallerRules.allows(packages, debugCallersAllowed, { releaseCertificate }, { sharesSigner })

  @Test
  fun releaseEvaNeedsThePinnedCertificate() {
    assertTrue(allows(listOf(EVA_PACKAGE), releaseCertificate = true))
    assertFalse(allows(listOf(EVA_PACKAGE), sharesSigner = true, debugCallersAllowed = true))
  }

  @Test
  fun productionBuildRejectsDebugEvaEvenWithASharedSigner() {
    assertFalse(allows(listOf(EVA_DEBUG_PACKAGE), debugCallersAllowed = false, sharesSigner = true))
  }

  @Test
  fun debugBuildAcceptsDebugEvaOnlyWithTheSameSigner() {
    assertTrue(allows(listOf(EVA_DEBUG_PACKAGE), debugCallersAllowed = true, sharesSigner = true))
    assertFalse(allows(listOf(EVA_DEBUG_PACKAGE), debugCallersAllowed = true, sharesSigner = false))
    assertFalse(
      allows(listOf(EVA_DEBUG_PACKAGE), debugCallersAllowed = true, releaseCertificate = true)
    )
  }

  @Test
  fun otherAndSharedUidCallersAreRejected() {
    assertFalse(allows(listOf("com.example.eva"), true, true, true))
    assertFalse(allows(listOf(EVA_PACKAGE, "com.example.other"), true, true, true))
    assertFalse(allows(emptyList(), true, true, true))
  }
}
