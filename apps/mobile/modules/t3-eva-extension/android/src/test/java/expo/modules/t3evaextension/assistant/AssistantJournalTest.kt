package expo.modules.t3evaextension.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AssistantJournalTest {
  @get:Rule val folder = TemporaryFolder()

  private var now = 1_000_000L
  private val journal by lazy { AssistantJournal(folder.root) { now } }
  private val args = mapOf<String, Any?>(
    "environmentId" to "e",
    "projectId" to "p",
    "prompt" to "hi"
  )
  private val planA = mapOf("kind" to "start_thread", "threadId" to "first")

  private fun admit(id: String) = (
    journal.admit(
      10123,
      id,
      AssistantOperation.START_THREAD,
      args
    ) as Admission.Created
    ).entry

  @Test
  fun replaysAreScopedToCallerAndBoundToTheirArguments() {
    val entry = admit("eva-1")
    assertEquals(ReceiptState.ACCEPTED, entry.state)
    assertTrue(
      journal.admit(10123, "eva-1", AssistantOperation.START_THREAD, args) is Admission.Existing
    )
    assertTrue(
      journal.admit(
        10123,
        "eva-1",
        AssistantOperation.START_THREAD,
        args + ("prompt" to "x")
      ) is Admission.Conflict
    )
    assertTrue(
      journal.admit(10123, "eva-1", AssistantOperation.SEND_MESSAGE, args) is Admission.Conflict
    )
    assertTrue(
      journal.admit(10999, "eva-1", AssistantOperation.START_THREAD, args) is Admission.Created
    )
    assertNull(journal.find(10123, "unknown"))
  }

  @Test
  fun anUnreadableRecordRefusesAdmission() {
    File(folder.root, "${journal.keyFor(10123, "eva-bad")}.json").writeText("{not json")
    assertTrue(
      journal.admit(10123, "eva-bad", AssistantOperation.START_THREAD, args) is Admission.Conflict
    )
  }

  @Test
  fun theFirstPlanWinsAndDispatchCannotBeUnclaimed() {
    val key = admit("eva-2").key
    journal.update(key, ReceiptUpdate(state = "accepted", dispatchStarted = true, plan = planA))
    val second = journal.update(
      key,
      ReceiptUpdate(dispatchStarted = true, plan = mapOf("kind" to "other"))
    )!!
    assertEquals(planA, second.plan)
    val claimed = journal.update(
      key,
      ReceiptUpdate(state = ReceiptState.REJECTED, errorCode = "unknown_environment")
    )!!
    assertEquals(ReceiptState.UNCERTAIN, claimed.state)
    assertEquals(
      ReceiptState.UNCERTAIN,
      journal.update(key, ReceiptUpdate(state = ReceiptState.COMPLETED))!!.state
    )
  }

  @Test
  fun dispatchIsOnlyRecordedWithAPlan() {
    val entry = journal.update(
      admit("eva-3").key,
      ReceiptUpdate(state = ReceiptState.REJECTED, dispatchStarted = true)
    )!!
    assertEquals(ReceiptState.REJECTED, entry.state)
    assertFalse(entry.dispatchStarted)
  }

  @Test
  fun submittedNeverRegressesAndStaleErrorsClear() {
    val key = admit("eva-4").key
    journal.update(
      key,
      ReceiptUpdate(
        state = ReceiptState.WAITING_FOR_HOST,
        errorCode = "host_offline",
        errorMessage = "offline"
      )
    )
    journal.update(
      key,
      ReceiptUpdate(state = ReceiptState.ACCEPTED, dispatchStarted = true, plan = planA)
    )
    val submitted = journal.update(
      key,
      ReceiptUpdate(state = ReceiptState.SUBMITTED, threadId = "th")
    )!!
    assertNull(submitted.errorCode)
    assertEquals(
      ReceiptState.SUBMITTED,
      journal.update(key, ReceiptUpdate(state = ReceiptState.WAITING_FOR_HOST))!!.state
    )
    val done = journal.update(
      key,
      ReceiptUpdate(state = ReceiptState.COMPLETED, threadId = "other")
    )!!
    assertEquals(listOf("th", false), listOf(done.threadId, done.receipt()["pollable"]))
    assertEquals(ReceiptState.COMPLETED, AssistantJournal(folder.root) { now }.get(key)!!.state)
  }

  @Test
  fun creationsKeepTheirEnvironmentAndCatalogRow() {
    val key = admit("eva-8").key
    journal.update(
      key,
      ReceiptUpdate(
        state = ReceiptState.ACCEPTED,
        dispatchStarted = true,
        plan = planA,
        environmentName = "ryzen-shine"
      )
    )
    val thread = mapOf(
      "id" to "th",
      "environmentId" to "e",
      "environmentName" to "ryzen-shine",
      "title" to "Fix it"
    )
    journal.update(
      key,
      ReceiptUpdate(
        state = ReceiptState.COMPLETED,
        threadId = "th",
        catalog = mapOf("thread" to thread)
      )
    )
    val reread = AssistantJournal(folder.root) { now }.get(key)!!
    assertEquals("ryzen-shine", reread.environmentName)
    assertEquals(thread, reread.createdRow("thread"))
    assertEquals("Fix it", reread.receipt()["threadTitle"])
    assertEquals(listOf(key), journal.creationsSince(0).map { it.key })
    assertTrue(journal.creationsSince(System.currentTimeMillis() + 60_000).isEmpty())
  }

  @Test
  fun overdueRequestsCloseAsExpiredOnlyWhenNothingWasSent() {
    val unsent = admit("eva-5").key
    val sent = admit("eva-6").key
    journal.update(
      sent,
      ReceiptUpdate(state = ReceiptState.ACCEPTED, dispatchStarted = true, plan = planA)
    )
    now += 11 * 60 * 1000L
    assertEquals(ReceiptState.EXPIRED, journal.expireIfOverdue(unsent)!!.state)
    assertEquals(ReceiptState.UNCERTAIN, journal.expireIfOverdue(sent)!!.state)
  }

  @Test
  fun awaitChangeWakesOnUpdate() {
    val entry = admit("eva-7")
    Thread {
      Thread.sleep(50)
      journal.update(entry.key, ReceiptUpdate(state = ReceiptState.SUBMITTED))
    }.start()
    assertEquals(
      ReceiptState.SUBMITTED,
      journal.awaitChange(entry.key, entry.revision, now + 5_000)!!.state
    )
  }
}
