package expo.modules.t3evaextension.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EvaProtocolTest {
  private val base = mapOf<String, Any?>(
    "environmentId" to "e",
    "projectId" to "p",
    "prompt" to "hi"
  )

  @Test
  fun lookupsRequireScopedTargetsAndBoundedLimits() {
    val messages = AssistantLookups.byName("read_messages")!!.capability
    val target = mapOf<String, Any?>("environmentId" to "e", "threadId" to "t")
    messages.validate(target + ("limit" to 50L))
    for (args in listOf(
      target - "environmentId",
      target - "threadId",
      target + ("limit" to 51L),
      target + ("limit" to 0L),
      target + ("q" to "ignored")
    )) {
      assertThrows(IllegalArgumentException::class.java) { messages.validate(args) }
    }
    AssistantLookups.byName("list_projects")!!.capability.validate(mapOf("q" to "assembly"))
    AssistantLookups.byName("list_requests")!!.capability.validate(emptyMap())
  }

  private fun threadRow(
    index: Int,
    environment: String = "railbird-sf"
  ) = linkedMapOf<String, Any?>(
    "id" to "0b5f7a9e-3c1d-4f2a-9e8b-%012d".format(index),
    "environmentId" to "fleet:$environment",
    "environmentName" to environment,
    "projectId" to "6a1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
    "projectName" to "railbird",
    "title" to "Investigate flaky upload retries in the ingest worker $index",
    "branch" to "t3/%08x".format(index),
    "worktreePath" to "/home/imalison/.t3/worktrees/railbird/t3-%08x".format(index),
    "provider" to "codex",
    "model" to "gpt-5.5",
    "status" to "completed",
    "lastActivityAt" to "2026-11-04T12:34:56.789Z",
  )

  private fun lookup(
    table: String,
    rows: List<Map<String, Any?>>,
    scope: LookupScope
  ): Pair<Map<String, Any?>, Map<*, *>> {
    val json = EvaProtocol.lookupReply("i", table, rows, scope)
    assertTrue(StrictJson.utf8Size(json) <= 16_384)
    val reply = StrictJson.parseObject(json)
    return reply to reply["structuredContent"] as Map<*, *>
  }

  private fun text(reply: Map<String, Any?>) =
    ((reply["content"] as List<*>).single() as Map<*, *>)["text"] as String

  @Test
  fun aCatalogListShorterThanTheLimitIsComplete() {
    val rows = List(17) { threadRow(it) }
    val (reply, result) =
      lookup("threads", rows, LookupScope(LookupScope.CATALOG, matched = 17))
    assertEquals(rows, result["rows"])
    assertEquals(false, reply["truncated"])
    assertEquals(true, result["complete"])
    assertEquals(emptyList<String>(), result["incompleteReasons"])
    assertEquals(null, result["nextOffset"])
    assertTrue(text(reply).startsWith("All 17 open threads that match."))
  }

  @Test
  fun rowsThatOverflowTheReplyBudgetArePagedByOffset() {
    val all = List(60) { threadRow(it) }
    val (first, page) = lookup("threads", all, LookupScope(LookupScope.CATALOG, matched = 60))
    val returned = (page["rows"] as List<*>).size
    // Rows used to be sent twice, as text and data, which capped this at 17.
    assertTrue("returned $returned", returned in 25 until 60)
    assertEquals(true, first["truncated"])
    assertEquals(false, page["complete"])
    assertEquals(listOf("response_size"), page["incompleteReasons"])
    assertEquals(returned.toLong(), page["nextOffset"])
    assertTrue(
      text(first).contains("list_threads again with the same filters and offset=$returned")
    )

    val rest = all.drop(returned)
    val (last, tail) =
      lookup(
        "threads",
        rest,
        LookupScope(LookupScope.CATALOG, offset = returned.toLong(), matched = 60)
      )
    assertEquals(rest, tail["rows"])
    assertEquals(false, last["truncated"])
    assertEquals(true, tail["complete"])
    assertEquals(null, tail["nextOffset"])
  }

  @Test
  fun aLimitBelowTheMatchCountIsIncompleteWithoutBeingTruncated() {
    val (reply, result) =
      lookup("threads", List(5) { threadRow(it) }, LookupScope(LookupScope.CATALOG, matched = 9))
    assertEquals(false, reply["truncated"])
    assertEquals(false, result["complete"])
    assertEquals(listOf("page_limit"), result["incompleteReasons"])
    assertEquals(5L, result["nextOffset"])
    assertTrue(text(reply).startsWith("Showing open threads 1-5 of 9 that match."))
  }

  @Test
  fun catalogGapsAndDisconnectedEnvironmentsAreNamed() {
    val rows = listOf(threadRow(0), threadRow(1, environment = "ryzen-shine"))
    val offline = mapOf("id" to "fleet:jay-lenovo", "name" to "jay-lenovo", "status" to "offline")
    val (reply, result) = lookup(
      "threads",
      rows,
      LookupScope(
        LookupScope.CATALOG,
        matched = 2,
        catalogOmitted = 3,
        staleEnvironments = listOf(offline)
      ),
    )
    assertEquals(false, result["complete"])
    assertEquals(listOf("catalog_cap"), result["incompleteReasons"])
    assertEquals(null, result["nextOffset"])
    assertEquals(listOf(offline), result["staleEnvironments"])
    assertTrue(text(reply).contains("leaves out 3 older open threads"))
    assertTrue(text(reply).contains("may be stale or missing: jay-lenovo"))

    val (missing, empty) =
      lookup(
        "threads",
        emptyList(),
        LookupScope(LookupScope.CATALOG, matched = 0, catalogAvailable = false)
      )
    assertEquals(false, empty["complete"])
    assertEquals(listOf("no_catalog"), empty["incompleteReasons"])
    assertTrue(text(missing).startsWith("Not an empty result"))
  }

  @Test
  fun liveNoticesAreUnavailableRatherThanEmpty() {
    val notice = mapOf("id" to "t", "environmentId" to "e", "status" to "notice", "note" to "busy")
    val (reply, result) = lookup("thread_status", listOf(notice), LookupScope.live)
    assertEquals(false, result["complete"])
    assertEquals(listOf("unavailable"), result["incompleteReasons"])
    assertEquals(1L, result["unavailableRows"])
    assertEquals(null, result["matched"])
    assertTrue(text(reply).contains("not an empty result"))

    val (_, read) = lookup(
      "thread_status",
      listOf(notice + ("status" to "running")),
      LookupScope.live
    )
    assertEquals(true, read["complete"])
  }

  @Test
  fun threadActivityGroupsRunStatuses() {
    assertEquals(
      listOf("working", "working", "needs_input", "idle", "idle", "idle"),
      listOf("running", "queued", "needs_input", "completed", "interrupted", "idle")
        .map(ThreadActivity::of),
    )
    AssistantLookups.byName("list_threads")!!.capability.validate(
      mapOf("activity" to "working", "offset" to 25L)
    )
    assertThrows(IllegalArgumentException::class.java) {
      AssistantLookups.byName("list_threads")!!.capability.validate(mapOf("activity" to "open"))
    }
  }

  @Test
  fun oversizedLookupResultsStayWithinTheWireBudgetAndReportTruncation() {
    for (rows in listOf(
      List(100) { mapOf("id" to "thread-$it", "text" to "message".repeat(100)) },
      listOf(mapOf("id" to "t", "text" to "😀\n\"".repeat(20_000)))
    )) {
      val json = EvaProtocol.lookupReply("i", "messages", rows)
      assertTrue(StrictJson.utf8Size(json) <= 16_384)
      val reply = StrictJson.parseObject(json)
      assertEquals("completed", reply["status"])
      assertEquals(true, reply["truncated"])
      assertTrue(((reply["structuredContent"] as Map<*, *>)["rows"] as List<*>).isNotEmpty())
    }
  }

  @Test
  fun strictJsonRejectsWhatOrgJsonAccepts() {
    listOf("""{"a":1,"a":2}""", "\"\\ud800\"", "1e999", "NaN", "{} {}", "{'a':1}").forEach { text ->
      assertThrows(text, IllegalArgumentException::class.java) { StrictJson.parse(text) }
    }
    assertEquals(12L, StrictJson.parse("12"))
    assertEquals(
      """{"a":["x"],"b":1}""",
      StrictJson.canonical(
        linkedMapOf(
          "b" to 1L,
          "a" to listOf("x")
        )
      )
    )
  }

  @Test
  fun startThreadArgumentsAreValidatedBeyondTheSchema() {
    val start = AssistantCapabilities.startThread
    assertEquals(base, start.validate(base + ("model" to null)))
    listOf(
      base + ("extra" to "x"),
      base - "projectId",
      base + ("title" to mapOf("a" to 1)),
      base + ("runtimeMode" to "yolo"),
      base + ("prompt" to "x".repeat(16_001)),
      base + ("prompt" to "   "),
    ).forEach { args ->
      assertThrows(IllegalArgumentException::class.java) { start.validate(args) }
    }
    listOf(
      base + ("baseBranch" to "main"),
      base + ("model" to "gpt"),
      base + ("workspace" to "branch"),
      base + ("workspace" to "pull_request") + ("branch" to "main"),
    ).forEach { args ->
      assertThrows(IllegalArgumentException::class.java) { start.validate(args) }
    }
    start.validate(base + ("workspace" to "worktree") + ("baseBranch" to "main"))
    start.validate(base + ("workspace" to "pull_request") + ("pullRequest" to "42"))
  }

  @Test
  fun threadActionsCheckWhatTheFlatSchemaCannot() {
    val target = mapOf<String, Any?>("environmentId" to "e", "threadId" to "t")
    val organize = AssistantCapabilities.organizeThread
    organize.validate(target + ("action" to "snooze") + ("snoozeMinutes" to 30L))
    listOf(
      target + ("action" to "snooze"),
      target + ("action" to "snooze") + ("snoozeMinutes" to 30L) + ("snoozeUntil" to "x"),
      target + ("action" to "pin") + ("snoozeMinutes" to 30L),
      target + ("action" to "snooze") + ("snoozeMinutes" to 0L),
    ).forEach { args ->
      assertThrows(IllegalArgumentException::class.java) { organize.validate(args) }
    }
    val answer = AssistantCapabilities.answerQuestion
    val request = target + ("requestId" to "r")
    assertThrows(IllegalArgumentException::class.java) { answer.validate(request) }
    answer.validate(request + ("answer" to "yes"))
    assertThrows(IllegalArgumentException::class.java) {
      AssistantCapabilities.configureThread.validate(target)
    }
  }

  @Test
  fun completedReceiptsReadTheExecutorsSummary() {
    val receipt =
      mapOf(
        "invocationId" to "i",
        "operation" to "organize_thread",
        "state" to "completed",
        "environmentName" to "ryzen-shine",
      )

    @Suppress("UNCHECKED_CAST")
    fun text(receipt: Map<String, Any?>) = (
      StrictJson.parseObject(
        EvaProtocol.executeReply(receipt)
      )["content"] as List<Map<String, Any?>>
      )[0]["text"]
    assertEquals("T3 Code updated the thread on ryzen-shine.", text(receipt))
    assertEquals("Archived “Fix”.", text(receipt + ("summary" to "Archived “Fix”.")))
  }

  @Test
  fun sendMessageTakesAThreadAndATurnBehavior() {
    val send = AssistantCapabilities.sendMessage
    val message = mapOf<String, Any?>(
      "environmentId" to "e",
      "threadId" to "t",
      "prompt" to "hi",
      "activeTurnBehavior" to "queue"
    )
    assertEquals(message, send.validate(message))
    listOf(
      message - "threadId",
      message + ("activeTurnBehavior" to "interrupt"),
      message + ("projectId" to "p")
    ).forEach { args ->
      assertThrows(IllegalArgumentException::class.java) { send.validate(args) }
    }
  }

  @Test
  fun receiptsNameTheEnvironmentAndTheCreatedThread() {
    val entry =
      AssistantRequestEntry(
        key = "k",
        callerUid = 1,
        invocationId = "i",
        operation = AssistantOperation.START_THREAD,
        fingerprint = "f",
        arguments = emptyMap(),
        createdAtMs = 0,
        updatedAtMs = 0,
        revision = 1,
        state = ReceiptState.COMPLETED,
        dispatchStarted = true,
        plan = emptyMap(),
        environmentId = "env",
        environmentName = "ryzen-shine",
        threadId = "th-1",
        catalog = mapOf(
          "thread" to mapOf("id" to "th-1", "title" to "Fix the login", "branch" to "t3code/fix")
        ),
        summary = null,
        errorCode = null,
        errorMessage = null,
      )
    val receipt = entry.receipt()
    assertEquals(
      listOf("ryzen-shine", "th-1", "Fix the login", "t3code/fix"),
      listOf("environmentName", "threadId", "threadTitle", "branch").map(receipt::get),
    )
    @Suppress("UNCHECKED_CAST")
    val text = (
      StrictJson.parseObject(
        EvaProtocol.executeReply(receipt)
      )["content"] as List<Map<String, Any?>>
      )[0]["text"]
    assertEquals("The new thread on ryzen-shine received the prompt in T3 Code.", text)
    val unnamed = entry.copy(environmentName = "", catalog = null).receipt()
    assertFalse(unnamed.containsKey("environmentName") || unnamed.containsKey("threadTitle"))
  }

  @Test
  fun descriptorUsesOnlyKeywordsEvaAccepts() {
    val allowed = setOf("type", "description", "enum", "minLength", "maxLength")
    val describe = EvaProtocol.describeReply()
    assertTrue(StrictJson.utf8Size(describe) <= 65_536)
    val descriptor = StrictJson.parseObject(describe)["descriptor"] as Map<*, *>
    for (entry in descriptor["capabilities"] as List<*>) {
      val tool = (entry as Map<*, *>)["tool"] as Map<*, *>
      val output = tool["outputSchema"] as Map<*, *>
      // EVA requires these fields even when additionalProperties is true.
      assertTrue(output["properties"] is Map<*, *>)
      assertTrue(output["required"] is List<*>)
    }
    for (capability in AssistantCapabilities.all) {
      @Suppress("UNCHECKED_CAST")
      val properties = capability.inputSchema()["properties"] as Map<String, Map<String, Any?>>
      properties.forEach { (name, schema) -> assertTrue(name, allowed.containsAll(schema.keys)) }
    }
    assertTrue(
      EvaProtocol.supportsDescribeRequest(
        """{"protocolVersion":1,"supportedProtocolVersions":[1]}"""
      )
    )
    assertFalse(
      EvaProtocol.supportsDescribeRequest(
        """{"protocolVersion":2,"supportedProtocolVersions":[2]}"""
      )
    )
  }

  @Test
  fun describeFailuresCarryANullDescriptor() {
    val reply = StrictJson.parseObject(
      EvaProtocol.describeFailure("not_executed", "unauthorized_caller", "no")
    )
    assertTrue(reply.containsKey("descriptor") && reply["descriptor"] == null)
    assertFalse(
      StrictJson.parseObject(
        EvaProtocol.failure("not_executed", "busy", "no")
      ).containsKey("descriptor")
    )
  }

  @Test
  fun receiptStatesMapToEvaEnvelopes() {
    val expected =
      mapOf(
        "completed" to ("completed" to null),
        "accepted" to ("handed_off" to null),
        "submitted" to ("handed_off" to null),
        "waiting_for_host" to ("handed_off" to null),
        "uncertain" to ("unknown" to null),
        "failed" to ("failed" to null),
        "rejected" to ("not_executed" to "invalid_arguments"),
        "request_id_conflict" to ("not_executed" to "invalid_arguments"),
        "unknown_request" to ("not_executed" to "invalid_arguments"),
        "expired" to ("not_executed" to "deadline_exceeded"),
        "not_started" to ("not_executed" to null),
        "needs_unlock" to ("not_executed" to "not_configured"),
        "needs_authorization" to ("not_executed" to "not_configured"),
        "needs_configuration" to ("not_executed" to "not_configured"),
        "needs_host_update" to ("not_executed" to "not_configured"),
      )
    expected.forEach { (state, mapping) ->
      assertEquals(state, mapping, EvaProtocol.statusFor(state))
    }
    val status = StrictJson.parseObject(
      EvaProtocol.statusReply(
        mapOf(
          "invocationId" to "i",
          "state" to "submitted"
        )
      )
    )
    assertEquals("completed", status["status"])
  }
}
