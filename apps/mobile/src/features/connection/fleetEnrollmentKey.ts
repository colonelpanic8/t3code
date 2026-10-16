import { FLEET_ENROLLMENT_MAX_BYTES } from "@t3tools/shared/fleetEnrollment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

/**
 * Owns the age identity that opens fleet enrollment files. The identity is
 * imported from the operator's backup, kept only in this device's keychain,
 * and never returned: callers see its public recipient and typed errors.
 */

const IDENTITY_STORAGE_KEY = "t3code.fleet-enrollment.age-identity.v1";
// Not restored from backups: a reinstall re-imports the identity from its backup.
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const IDENTITY_PATTERN = /^AGE-SECRET-KEY-(?:PQ-)?1[02-9AC-HJ-NP-Z]+$/;

export const AgeRecipient = Schema.String.check(
  Schema.isPattern(/^age1(?:pq1)?[02-9ac-hj-np-z]+$/),
).pipe(Schema.brand("AgeRecipient"));
export type AgeRecipient = typeof AgeRecipient.Type;
const decodeAgeRecipient = Schema.decodeUnknownOption(AgeRecipient);

export class EnrollmentKeyError extends Schema.TaggedError<EnrollmentKeyError>()(
  "EnrollmentKeyError",
  { reason: Schema.Literals(["invalid", "storage"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid":
        return "That is not an age identity. Paste the AGE-SECRET-KEY line from your backup.";
      case "storage":
        return "Could not access the fleet enrollment key on this device.";
    }
  }
}

export class EnrollmentDecryptError extends Schema.TaggedError<EnrollmentDecryptError>()(
  "EnrollmentDecryptError",
  {
    reason: Schema.Literals([
      "no-identity",
      "not-a-recipient",
      "corrupt",
      "too-large",
      "runtime-unsupported",
      "storage",
    ]),
    /** Class name of the library error, never its message. */
    causeName: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-identity":
        return "Import your fleet enrollment key first.";
      case "not-a-recipient":
        return "That file was not encrypted to this device's fleet enrollment key.";
      case "corrupt":
        return "That fleet enrollment file is damaged.";
      case "too-large":
        return "That fleet enrollment file is too large.";
      case "runtime-unsupported":
        return "This device cannot open fleet enrollment files.";
      case "storage":
        return "Could not access the fleet enrollment key on this device.";
    }
  }
}

const BINARY_HEADER = new TextEncoder().encode("age-encryption.org/v1\n");
const ARMOR_HEADER = new TextEncoder().encode("-----BEGIN AGE ENCRYPTED FILE-----");

function startsWith(bytes: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.byteLength) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function leadingWhitespace(bytes: Uint8Array): number {
  let offset = 0;
  while (offset < bytes.byteLength && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[offset]!)) offset++;
  return offset;
}

function isArmored(bytes: Uint8Array): boolean {
  return startsWith(bytes, ARMOR_HEADER, leadingWhitespace(bytes));
}

/** Whether a picked file is an age file, binary or armored, rather than a plain fleet file. */
export function isAgeEncryptedFile(bytes: Uint8Array): boolean {
  return startsWith(bytes, BINARY_HEADER) || isArmored(bytes);
}

const storageError = () => new EnrollmentKeyError({ reason: "storage" });

const readStoredIdentity = Effect.tryPromise({
  try: () => SecureStore.getItemAsync(IDENTITY_STORAGE_KEY, STORE_OPTIONS),
  catch: storageError,
});

async function recipientOf(identity: string): Promise<AgeRecipient | null> {
  if (!IDENTITY_PATTERN.test(identity)) return null;
  const { identityToRecipient } = await import("age-encryption");
  try {
    return Option.getOrNull(decodeAgeRecipient(await identityToRecipient(identity)));
  } catch {
    return null;
  }
}

/**
 * Accepts the identity alone or a whole `age-keygen` file, even flattened onto
 * one line by a single-line field. Anything else is rejected without
 * repeating the input.
 */
function parseIdentity(text: string): string | null {
  const keys = text.split(/\s+/).filter((word) => word.startsWith("AGE-SECRET-KEY-"));
  return keys.length === 1 ? keys[0]! : null;
}

export const loadEnrollmentIdentity = Effect.fn("fleetEnrollmentKey.load")(function* () {
  const stored = yield* readStoredIdentity;
  if (stored === null) return Option.none<{ readonly recipient: AgeRecipient }>();
  const recipient = yield* Effect.promise(() => recipientOf(stored));
  if (recipient === null) return yield* storageError();
  return Option.some({ recipient });
});

/** Validates before writing, so a bad paste never replaces a working identity. */
export const importEnrollmentIdentity = Effect.fn("fleetEnrollmentKey.import")(function* (
  input: Redacted.Redacted<string>,
) {
  const identity = parseIdentity(Redacted.value(input));
  const recipient = identity === null ? null : yield* Effect.promise(() => recipientOf(identity));
  if (identity === null || recipient === null) {
    return yield* new EnrollmentKeyError({ reason: "invalid" });
  }
  yield* Effect.tryPromise({
    try: () => SecureStore.setItemAsync(IDENTITY_STORAGE_KEY, identity, STORE_OPTIONS),
    catch: storageError,
  });
  return { recipient };
});

export const removeEnrollmentIdentity = Effect.fn("fleetEnrollmentKey.remove")(function* () {
  yield* Effect.tryPromise({
    try: () => SecureStore.deleteItemAsync(IDENTITY_STORAGE_KEY, STORE_OPTIONS),
    catch: storageError,
  });
});

class PlaintextTooLarge extends Error {}

/**
 * Typage's byte API buffers through `Response`, which React Native does not
 * implement for streams, so this always goes through the stream API and reads
 * the plaintext itself, stopping past the enrollment size cap.
 */
async function decryptBounded(identity: string, file: Uint8Array): Promise<Uint8Array> {
  const age = await import("age-encryption");
  const ciphertext = isArmored(file) ? age.armor.decode(new TextDecoder().decode(file)) : file;
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ciphertext);
      controller.close();
    },
  });
  const reader = (await decrypter.decrypt(source)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FLEET_ENROLLMENT_MAX_BYTES) {
      await reader.cancel();
      throw new PlaintextTooLarge();
    }
    chunks.push(value);
  }
  const plaintext = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    plaintext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return plaintext;
}

function classifyDecryptFailure(cause: unknown): EnrollmentDecryptError {
  if (cause instanceof PlaintextTooLarge)
    return new EnrollmentDecryptError({ reason: "too-large" });
  if (cause instanceof Error && cause.message.startsWith("no identity matched")) {
    return new EnrollmentDecryptError({ reason: "not-a-recipient" });
  }
  const causeName = cause instanceof Error ? cause.constructor.name : typeof cause;
  return new EnrollmentDecryptError({ reason: "corrupt", causeName });
}

export const decryptFleetEnrollmentFile = Effect.fn("fleetEnrollmentKey.decrypt")(function* (
  file: Uint8Array,
) {
  if (typeof ReadableStream !== "function" || typeof TransformStream !== "function") {
    return yield* new EnrollmentDecryptError({ reason: "runtime-unsupported" });
  }
  const identity = yield* readStoredIdentity.pipe(
    Effect.mapError(() => new EnrollmentDecryptError({ reason: "storage" })),
  );
  if (identity === null) return yield* new EnrollmentDecryptError({ reason: "no-identity" });
  return yield* Effect.tryPromise({
    try: () => decryptBounded(identity, file),
    catch: classifyDecryptFailure,
  });
});
