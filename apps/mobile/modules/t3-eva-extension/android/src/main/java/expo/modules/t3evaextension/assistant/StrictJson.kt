package expo.modules.t3evaextension.assistant

import java.util.Locale

class StrictJsonException(message: String) : IllegalArgumentException(message)

/**
 * RFC 8259 JSON without leniency: duplicate keys, lone surrogates, nonfinite
 * numbers, and trailing input are errors. Android's org.json accepts all of
 * those, which the EVA protocol forbids. Objects decode to insertion-ordered
 * maps, integers to Long, other numbers to Double.
 */
object StrictJson {
  private const val MAX_DEPTH = 32

  fun parse(text: String): Any? {
    val parser = Parser(text)
    parser.skipWhitespace()
    val value = parser.readValue(0)
    parser.skipWhitespace()
    if (!parser.atEnd()) throw StrictJsonException("Trailing data after JSON value")
    return value
  }

  fun parseObject(text: String): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return parse(text) as? Map<String, Any?> ?: throw StrictJsonException("Expected a JSON object")
  }

  /** Serializes with sorted object keys, so equal values always produce equal text. */
  fun canonical(
    value: Any?
  ): String = StringBuilder().also { write(it, value, sortKeys = true) }.toString()

  fun stringify(value: Any?): String = StringBuilder().also {
    write(it, value, sortKeys = false)
  }.toString()

  private fun write(out: StringBuilder, value: Any?, sortKeys: Boolean) {
    when (value) {
      null -> out.append("null")
      is String -> writeString(out, value)
      is Boolean -> out.append(value)
      is Int, is Long -> out.append(value.toString())
      is Double -> {
        require(value.isFinite()) { "Nonfinite number" }
        if (value == Math.floor(value) &&
          Math.abs(value) < 1e15
        ) {
          out.append(value.toLong())
        } else {
          out.append(value)
        }
      }
      is Map<*, *> -> {
        out.append('{')
        val entries = value.entries.map { (key, item) -> (key as String) to item }
        val ordered = if (sortKeys) entries.sortedBy { it.first } else entries
        ordered.forEachIndexed { index, (key, item) ->
          if (index > 0) out.append(',')
          writeString(out, key)
          out.append(':')
          write(out, item, sortKeys)
        }
        out.append('}')
      }
      is List<*> -> {
        out.append('[')
        value.forEachIndexed { index, item ->
          if (index > 0) out.append(',')
          write(out, item, sortKeys)
        }
        out.append(']')
      }
      else -> throw IllegalArgumentException("Cannot serialize ${value::class.java.simpleName}")
    }
  }

  private fun writeString(out: StringBuilder, value: String) {
    out.append('"')
    for (char in value) {
      when (char) {
        '"' -> out.append("\\\"")
        '\\' -> out.append("\\\\")
        '\n' -> out.append("\\n")
        '\r' -> out.append("\\r")
        '\t' -> out.append("\\t")
        '\b' -> out.append("\\b")
        '\u000C' -> out.append("\\f")
        else ->
          if (char < ' ' || char == ' ' || char == ' ') {
            out.append(String.format(Locale.ROOT, "\\u%04x", char.code))
          } else {
            out.append(char)
          }
      }
    }
    out.append('"')
  }

  /** True when [value] has no unpaired UTF-16 surrogate, so it encodes as valid UTF-8. */
  @Suppress("ReturnCount")
  fun isWellFormed(value: String): Boolean {
    var index = 0
    while (index < value.length) {
      val char = value[index]
      if (Character.isHighSurrogate(char)) {
        if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) return false
        index += 2
        continue
      }
      if (Character.isLowSurrogate(char)) return false
      index += 1
    }
    return true
  }

  fun utf8Size(value: String): Int = value.toByteArray(Charsets.UTF_8).size

  private class Parser(private val text: String) {
    private var index = 0

    fun atEnd() = index >= text.length

    fun skipWhitespace() {
      while (index < text.length && text[index] in " \t\n\r") index += 1
    }

    @Suppress("ThrowsCount")
    fun readValue(depth: Int): Any? {
      if (depth > MAX_DEPTH) throw StrictJsonException("JSON nested too deeply")
      if (atEnd()) throw StrictJsonException("Unexpected end of JSON")
      return when (val char = text[index]) {
        '{' -> readObject(depth)
        '[' -> readArray(depth)
        '"' -> readString()
        't' -> readLiteral("true", true)
        'f' -> readLiteral("false", false)
        'n' -> readLiteral("null", null)
        else -> if (char == '-' ||
          char in '0'..'9'
        ) {
          readNumber()
        } else {
          throw StrictJsonException("Unexpected character")
        }
      }
    }

    @Suppress("ThrowsCount")
    private fun readObject(depth: Int): Map<String, Any?> {
      index += 1
      val result = LinkedHashMap<String, Any?>()
      skipWhitespace()
      if (peek() == '}') {
        index += 1
        return result
      }
      while (true) {
        skipWhitespace()
        if (peek() != '"') throw StrictJsonException("Expected an object key")
        val key = readString()
        if (result.containsKey(key)) throw StrictJsonException("Duplicate object key")
        skipWhitespace()
        expect(':')
        skipWhitespace()
        result[key] = readValue(depth + 1)
        skipWhitespace()
        when (peek()) {
          ',' -> index += 1
          '}' -> {
            index += 1
            return result
          }
          else -> throw StrictJsonException("Expected , or }")
        }
      }
    }

    private fun readArray(depth: Int): List<Any?> {
      index += 1
      val result = ArrayList<Any?>()
      skipWhitespace()
      if (peek() == ']') {
        index += 1
        return result
      }
      while (true) {
        skipWhitespace()
        result.add(readValue(depth + 1))
        skipWhitespace()
        when (peek()) {
          ',' -> index += 1
          ']' -> {
            index += 1
            return result
          }
          else -> throw StrictJsonException("Expected , or ]")
        }
      }
    }

    @Suppress("CyclomaticComplexMethod", "NestedBlockDepth", "ThrowsCount")
    private fun readString(): String {
      expect('"')
      val out = StringBuilder()
      while (true) {
        if (atEnd()) throw StrictJsonException("Unterminated string")
        val char = text[index++]
        when {
          char == '"' -> break
          char == '\\' -> {
            if (atEnd()) throw StrictJsonException("Unterminated escape")
            when (val escape = text[index++]) {
              '"' -> out.append('"')
              '\\' -> out.append('\\')
              '/' -> out.append('/')
              'b' -> out.append('\b')
              'f' -> out.append('\u000C')
              'n' -> out.append('\n')
              'r' -> out.append('\r')
              't' -> out.append('\t')
              'u' -> {
                if (index + 4 > text.length) throw StrictJsonException("Bad unicode escape")
                val code = text.substring(index, index + 4).toIntOrNull(16)
                  ?: throw StrictJsonException("Bad unicode escape")
                out.append(code.toChar())
                index += 4
              }
              else -> throw StrictJsonException("Bad escape \\$escape")
            }
          }
          char < ' ' -> throw StrictJsonException("Control character in string")
          else -> out.append(char)
        }
      }
      val value = out.toString()
      if (!isWellFormed(value)) throw StrictJsonException("Invalid Unicode in string")
      return value
    }

    @Suppress("CyclomaticComplexMethod", "ThrowsCount")
    private fun readNumber(): Any {
      val start = index
      if (peek() == '-') index += 1
      if (peek() == '0') {
        index += 1
      } else if (peek() in '1'..'9') {
        while (peek() in '0'..'9') index += 1
      } else {
        throw StrictJsonException("Bad number")
      }
      var integral = true
      if (peek() == '.') {
        integral = false
        index += 1
        if (peek() !in '0'..'9') throw StrictJsonException("Bad number")
        while (peek() in '0'..'9') index += 1
      }
      if (peek() == 'e' || peek() == 'E') {
        integral = false
        index += 1
        if (peek() == '+' || peek() == '-') index += 1
        if (peek() !in '0'..'9') throw StrictJsonException("Bad number")
        while (peek() in '0'..'9') index += 1
      }
      val literal = text.substring(start, index)
      if (integral) literal.toLongOrNull()?.let { return it }
      val number = literal.toDouble()
      if (!number.isFinite()) throw StrictJsonException("Nonfinite number")
      return number
    }

    private fun readLiteral(literal: String, value: Any?): Any? {
      if (!text.startsWith(literal, index)) throw StrictJsonException("Unexpected literal")
      index += literal.length
      return value
    }

    private fun peek(): Char = if (atEnd()) '\u0000' else text[index]

    private fun expect(char: Char) {
      if (peek() != char) throw StrictJsonException("Expected $char")
      index += 1
    }
  }
}
