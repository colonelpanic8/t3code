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

  @Test
  fun lookupRepliesIncludeRowsInBothTextAndStructuredResults() {
    val rows = listOf(mapOf("id" to "e", "name" to "desktop", "connected" to 1L))
    val reply = StrictJson.parseObject(EvaProtocol.lookupReply("i", "environments", rows))
    val result = reply["structuredContent"] as Map<*, *>
    assertEquals(rows, result["rows"])
    assertEquals(false, reply["truncated"])
    val text = ((reply["content"] as List<*>).single() as Map<*, *>)["text"] as String
    assertEquals(result, StrictJson.parseObject(text))
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
