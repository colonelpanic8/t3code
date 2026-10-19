package expo.modules.t3evaextension.assistant

import org.junit.Assert.assertEquals
import org.junit.Test

class CreatedCatalogRowsTest {
  private fun creation(
    key: String,
    updatedAtMs: Long,
    threadId: String,
    environmentId: String = "env"
  ) =
    AssistantRequestEntry(
      key = key,
      callerUid = 1,
      invocationId = key,
      operation = AssistantOperation.START_THREAD,
      fingerprint = "f",
      arguments = emptyMap(),
      createdAtMs = updatedAtMs,
      updatedAtMs = updatedAtMs,
      revision = 1,
      state = ReceiptState.COMPLETED,
      dispatchStarted = true,
      plan = emptyMap(),
      environmentId = environmentId,
      environmentName = "ryzen-shine",
      threadId = threadId,
      catalog = mapOf(
        "thread" to
          mapOf(
            "id" to threadId,
            "environmentId" to environmentId,
            "environmentName" to "ryzen-shine"
          )
      ),
      summary = null,
      errorCode = null,
      errorMessage = null,
    )

  private fun ids(rows: List<Map<String, Any?>>) = rows.map { it["id"] }

  @Test
  fun servesCreationsTheCatalogHasNotListedNewestFirst() {
    val entries =
      listOf(creation("a", 100, "th-a"), creation("b", 300, "th-b"), creation("c", 200, "th-c"))
    assertEquals(
      listOf("th-b", "th-c", "th-a"),
      ids(CreatedCatalogRows.rows("threads", entries, emptySet(), null))
    )
    assertEquals(
      listOf("th-b", "th-a"),
      ids(CreatedCatalogRows.rows("threads", entries, setOf("env" to "th-c"), null))
    )
    assertEquals(emptyList<Any?>(), CreatedCatalogRows.rows("projects", entries, emptySet(), null))
  }

  @Test
  fun aCatalogCapturedAfterTheCreationWins() {
    val entries = listOf(creation("a", 100, "th-a"), creation("b", 300, "th-b"))
    assertEquals(listOf("th-b"), ids(CreatedCatalogRows.rows("threads", entries, emptySet(), 200)))
  }

  @Test
  fun identityIncludesTheEnvironment() {
    val entries =
      listOf(
        creation("a", 100, "th-1", environmentId = "laptop"),
        creation("b", 200, "th-1", environmentId = "desktop")
      )
    val rows = CreatedCatalogRows.rows("threads", entries, setOf("laptop" to "th-1"), null)
    assertEquals(listOf("desktop"), rows.map { it["environmentId"] })
  }
}
