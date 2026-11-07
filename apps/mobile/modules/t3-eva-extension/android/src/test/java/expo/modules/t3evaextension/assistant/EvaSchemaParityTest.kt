package expo.modules.t3evaextension.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * EVA validates arguments against the advertised input schema before sending them, so every
 * value that schema admits must pass this side's validation too. The checks below port EVA's
 * input-schema rules (ToolSchema and ExtensionProtocol in colonelpanic8/eva).
 */
class EvaSchemaParityTest {
  private val name = Regex("[A-Za-z_][A-Za-z0-9_]{0,63}")
  private val property = Regex("[A-Za-z][A-Za-z0-9_]{0,63}")
  private val keywords =
    mapOf(
      "string" to setOf("type", "description", "enum", "minLength", "maxLength"),
      "integer" to setOf("type", "description", "enum", "minimum", "maximum"),
    )

  private fun codePoints(text: String) = text.codePointCount(0, text.length)

  private fun bound(schema: Map<String, Any?>, key: String, fallback: Double) =
    (schema[key] as? Number)?.toDouble() ?: fallback

  /** EVA's ToolSchema.error for a scalar property: true when EVA would send [value]. */
  private fun evaAccepts(schema: Map<String, Any?>, value: Any?): Boolean {
    val shaped =
      when (schema["type"]) {
        "string" ->
          value is String &&
            codePoints(value).toDouble() in
            bound(schema, "minLength", 0.0)..bound(schema, "maxLength", Double.MAX_VALUE)
        "integer" -> {
          val number = (value as? Number)?.toDouble()
          number != null && number.isFinite() && number % 1.0 == 0.0 &&
            number in
            bound(schema, "minimum", -Double.MAX_VALUE)..bound(schema, "maximum", Double.MAX_VALUE)
        }
        else -> false
      }
    val values = schema["enum"] as? List<*>
    return shaped && (values == null || value in values)
  }

  private fun t3Accepts(field: Field, value: Any?): Boolean =
    try {
      field.validate(value)
      true
    } catch (_: InvalidArgumentsException) {
      false
    }

  /** Values at the edges of what [schema] admits, and just outside them. */
  @Suppress("UNCHECKED_CAST")
  private fun samples(schema: Map<String, Any?>): Pair<List<Any>, List<Any>> {
    (schema["enum"] as? List<Any>)?.let { values -> return values to listOf("not-a-choice") }
    return when (schema["type"]) {
      "string" -> {
        val min = (schema["minLength"] as Number).toInt()
        val max = (schema["maxLength"] as Number).toInt()
        // Whitespace-only text meets minLength but is refused here; EVA's dialect has no pattern.
        listOf("a".repeat(maxOf(min, 1)), "a".repeat(max), "😀".repeat(max)) to
          listOfNotNull("a".repeat(max + 1), if (min > 0) "" else null)
      }
      "integer" -> {
        val min = (schema["minimum"] as Number).toLong()
        val max = (schema["maximum"] as Number).toLong()
        listOf(min, max) to listOf(min - 1, max + 1, "1")
      }
      else -> error("Unexpected type ${schema["type"]}")
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun properties(capability: Capability) =
    capability.inputSchema()["properties"] as Map<String, Map<String, Any?>>

  @Test
  fun descriptorFitsEvasInstalledExtensionRules() {
    for (capability in AssistantCapabilities.all) {
      val label = capability.name
      assertTrue(label, name.matches(capability.name))
      assertTrue(label, codePoints(capability.title) in 1..120)
      assertTrue(label, codePoints(capability.description) in 1..2000)
      val schema = capability.inputSchema()
      assertEquals(label, false, schema["additionalProperties"])
      val props = properties(capability)
      assertTrue(label, props.size <= 64)
      val required = schema["required"] as List<*>
      assertTrue(label, props.keys.containsAll(required) && required.distinct() == required)
      for ((key, child) in props) {
        assertTrue("$label.$key", property.matches(key))
        val allowed = keywords[child["type"]] ?: error("$label.$key has type ${child["type"]}")
        assertTrue("$label.$key", allowed.containsAll(child.keys))
        assertTrue("$label.$key", codePoints(child["description"] as String) <= 2000)
        (child["enum"] as? List<*>)?.let { assertTrue("$label.$key", it.size in 1..64) }
        if (child["type"] == "integer") {
          assertTrue("$label.$key declares its bounds", "minimum" in child && "maximum" in child)
        }
      }
      capability.confirmation()?.let { confirmation ->
        val confirmed = (confirmation["parameters"] as Map<*, *>).keys
        assertTrue(label, props.keys.containsAll(confirmed))
      }
    }
  }

  @Test
  fun everyValueEvaSendsIsAcceptedAndEveryValueItRefusesIsRefused() {
    for (capability in AssistantCapabilities.all) {
      val fields = capability.fields.associateBy { it.name }
      for ((key, schema) in properties(capability)) {
        val field = fields.getValue(key)
        val (inside, outside) = samples(schema)
        for (value in inside) {
          assertTrue("EVA sends ${capability.name}.$key=$value", evaAccepts(schema, value))
          assertTrue("T3 refuses ${capability.name}.$key=$value", t3Accepts(field, value))
        }
        for (value in outside) {
          assertFalse("EVA sends ${capability.name}.$key=$value", evaAccepts(schema, value))
          assertFalse("T3 accepts ${capability.name}.$key=$value", t3Accepts(field, value))
        }
      }
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun withoutDescriptions(schema: Map<String, Any?>): Map<String, Any?> =
    schema.filterKeys { it != "description" }.mapValues { (key, value) ->
      if (key == "properties") {
        (value as Map<String, Map<String, Any?>>).mapValues { withoutDescriptions(it.value) }
      } else {
        value
      }
    }

  /**
   * The TypeScript executor decodes the arguments this side saved; its test reads the same
   * fixture. When a schema changes, replace the fixture with the expected JSON in this failure.
   */
  @Test
  fun inputSchemasMatchTheFixtureTheExecutorIsTestedAgainst() {
    val expected =
      AssistantCapabilities.all.associateTo(linkedMapOf()) {
        it.name to withoutDescriptions(it.inputSchema())
      }
    val fixture =
      javaClass.getResourceAsStream("/eva-input-schemas.json")!!.reader(Charsets.UTF_8).readText()
    assertEquals(
      StrictJson.stringify(expected),
      StrictJson.canonical(expected),
      StrictJson.canonical(StrictJson.parseObject(fixture))
    )
  }
}
