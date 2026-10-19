package expo.modules.t3evaextension.assistant

import java.io.File
import java.io.IOException
import java.security.MessageDigest

private const val MAX_ENTRIES = 200
private const val RETENTION_MS = 7 * 24 * 60 * 60 * 1000L
private const val MTIME_SLACK_MS = 2_000L

class UnreadableRecordException(cause: Throwable) : IOException(cause)

sealed class Admission {
  data class Created(val entry: AssistantRequestEntry) : Admission()

  data class Existing(val entry: AssistantRequestEntry) : Admission()

  object Conflict : Admission()
}

/**
 * Durable record of every assistant request, keyed by caller UID and
 * invocation ID. Written before any network work so a replayed invocation
 * finds its earlier self instead of running twice. Lives in credential-
 * encrypted app storage: it holds prompts, and nothing here should work
 * before the user's first unlock.
 */
class AssistantJournal(
  private val directory: File,
  private val clock: () -> Long = System::currentTimeMillis
) {
  private val lock = Object()

  fun keyFor(callerUid: Int, invocationId: String): String = sha256("$callerUid\u0000$invocationId")

  fun admit(
    callerUid: Int,
    invocationId: String,
    operation: AssistantOperation,
    arguments: Map<String, Any?>
  ): Admission =
    synchronized(lock) {
      val key = keyFor(callerUid, invocationId)
      val fingerprint = fingerprintOf(operation, arguments)
      val existing =
        try {
          readLocked(key)
        } catch (_: UnreadableRecordException) {
          // A record we cannot read may describe work that already ran.
          return Admission.Conflict
        }
      if (existing != null) {
        return if (existing.fingerprint ==
          fingerprint
        ) {
          Admission.Existing(existing)
        } else {
          Admission.Conflict
        }
      }
      val now = clock()
      val entry =
        AssistantRequestEntry(
          key = key,
          callerUid = callerUid,
          invocationId = invocationId,
          operation = operation,
          fingerprint = fingerprint,
          arguments = arguments,
          createdAtMs = now,
          updatedAtMs = now,
          revision = 0,
          state = ReceiptState.ACCEPTED,
          dispatchStarted = false,
          plan = null,
          environmentId = arguments["environmentId"] as String,
          environmentName = null,
          threadId = arguments["threadId"] as String?,
          catalog = null,
          summary = null,
          errorCode = null,
          errorMessage = null,
        )
      pruneLocked()
      writeLocked(entry)
      Admission.Created(entry)
    }

  fun find(callerUid: Int, invocationId: String): AssistantRequestEntry? = get(
    keyFor(callerUid, invocationId)
  )

  fun get(key: String): AssistantRequestEntry? = synchronized(lock) { readOrNullLocked(key) }

  /**
   * Entries that recorded created catalog rows, from files modified since
   * about [sinceMs]. File times can be coarse, so callers still filter by
   * updatedAtMs.
   */
  fun creationsSince(sinceMs: Long): List<AssistantRequestEntry> =
    synchronized(lock) {
      val cutoff = sinceMs - MTIME_SLACK_MS
      val files =
        directory.listFiles { file -> file.name.endsWith(".json") && file.lastModified() >= cutoff }
          ?: return emptyList()
      files.mapNotNull { file ->
        readOrNullLocked(file.name.removeSuffix(".json"))?.takeIf {
          it.catalog !=
            null
        }
      }
    }

  fun update(key: String, update: ReceiptUpdate): AssistantRequestEntry? = mutate(key) {
    ReceiptRules.apply(it, update, clock())
  }

  /** Closes an overdue pending request; returns the entry as it now stands. */
  fun expireIfOverdue(
    key: String
  ): AssistantRequestEntry? = mutate(key) {
    ReceiptRules.expire(it, clock())
      ?: it
  }

  /** Blocks until the entry's revision passes [revision] or [untilMs] (wall clock) arrives. */
  fun awaitChange(key: String, revision: Long, untilMs: Long): AssistantRequestEntry? =
    synchronized(lock) {
      var entry = readOrNullLocked(key)
      while (entry != null && entry.revision == revision) {
        val remaining = untilMs - clock()
        if (remaining <= 0) break
        lock.wait(remaining)
        entry = readOrNullLocked(key)
      }
      entry
    }

  private fun mutate(
    key: String,
    change: (AssistantRequestEntry) -> AssistantRequestEntry
  ): AssistantRequestEntry? =
    synchronized(lock) {
      val entry = readOrNullLocked(key) ?: return null
      val next = change(entry)
      if (next != entry) {
        writeLocked(next)
        lock.notifyAll()
      }
      next
    }

  // A damaged record can fail decoding in any way; all of them mean unreadable.
  @Suppress("TooGenericExceptionCaught")
  private fun readLocked(key: String): AssistantRequestEntry? {
    val file = File(directory, "$key.json")
    if (!file.isFile) return null
    return try {
      AssistantRequestEntry.fromJson(StrictJson.parseObject(file.readText(Charsets.UTF_8)))
    } catch (error: Exception) {
      throw UnreadableRecordException(error)
    }
  }

  private fun readOrNullLocked(key: String): AssistantRequestEntry? =
    try {
      readLocked(key)
    } catch (_: UnreadableRecordException) {
      null
    }

  private fun writeLocked(entry: AssistantRequestEntry) {
    if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Cannot create $directory")
    val target = File(directory, "${entry.key}.json")
    val temp = File(directory, "${entry.key}.json.tmp")
    temp.outputStream().use { stream ->
      stream.write(StrictJson.stringify(entry.toJson()).toByteArray(Charsets.UTF_8))
      stream.fd.sync()
    }
    if (!temp.renameTo(target)) throw IOException("Cannot commit ${target.name}")
  }

  @Suppress("TooGenericExceptionCaught")
  private fun pruneLocked() {
    val files = directory.listFiles { file -> file.name.endsWith(".json") } ?: return
    val now = clock()
    val entries =
      files.mapNotNull { file ->
        try {
          file to
            AssistantRequestEntry.fromJson(StrictJson.parseObject(file.readText(Charsets.UTF_8)))
        } catch (_: Exception) {
          null
        }
      }
    val stale = entries.filter { (_, entry) -> now - entry.updatedAtMs > RETENTION_MS }
    stale.forEach { (file, _) -> file.delete() }
    val remaining = (entries - stale.toSet()).filterNot { (_, entry) ->
      entry.isPending
    }.sortedBy { it.second.updatedAtMs }
    val excess = entries.size - stale.size - (MAX_ENTRIES - 1)
    if (excess > 0) remaining.take(excess).forEach { (file, _) -> file.delete() }
  }

  companion object {
    fun fingerprintOf(operation: AssistantOperation, arguments: Map<String, Any?>): String =
      sha256(StrictJson.canonical(mapOf("operation" to operation.wire, "arguments" to arguments)))

    fun sha256(value: String): String =
      MessageDigest.getInstance(
        "SHA-256"
      ).digest(value.toByteArray(Charsets.UTF_8)).joinToString("") {
        "%02x".format(it)
      }
  }
}
