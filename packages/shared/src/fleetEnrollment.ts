import { ServerFleetEnvironment } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const FLEET_ENROLLMENT_MAX_BYTES = 4096;

export const FleetEnrollmentCredential = Schema.String.check(
  Schema.isPattern(/^t3enroll1\.[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("FleetEnrollmentCredential"));
export type FleetEnrollmentCredential = typeof FleetEnrollmentCredential.Type;

/** Routes the reserved prefix; the credential schema validates the full value. */
export const isFleetEnrollmentCredential = (value: string): boolean =>
  value.startsWith("t3enroll1.");

const EnrollmentPayload = Schema.Struct({
  anchor: Schema.Struct({
    ...ServerFleetEnvironment.fields,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  }),
  credential: Schema.RedactedFromValue(FleetEnrollmentCredential),
  expiresAt: Schema.DateTimeUtcFromString,
});
export type FleetEnrollment = typeof EnrollmentPayload.Type;

const EnrollmentDocument = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("t3code.fleet-enrollment"),
  ...EnrollmentPayload.fields,
});
const decodeDocument = Schema.decodeUnknownResult(EnrollmentDocument, {
  onExcessProperty: "error",
});
const encodeDocument = Schema.encodeUnknownResult(EnrollmentDocument);

export class FleetEnrollmentDecodeError extends Schema.TaggedError<FleetEnrollmentDecodeError>()(
  "FleetEnrollmentDecodeError",
  { reason: Schema.Literals(["too-large", "malformed", "unsafe-url"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return "That fleet enrollment file is too large.";
      case "malformed":
        return "That file is not a T3 Code fleet enrollment file.";
      case "unsafe-url":
        return "That fleet enrollment file has an address that is not a plain server URL.";
    }
  }
}

// Exclude URL syntax that can carry credentials or change authority parsing.
const UNSAFE_URL_CHARACTER = /[\p{Cc}\s\\?#@]/u;

function parsePlainUrl(value: string): URL | null {
  if (UNSAFE_URL_CHARACTER.test(value)) return null;
  try {
    const url = new URL(value);
    return value.toLowerCase().startsWith(`${url.protocol}//`) ? url : null;
  } catch {
    return null;
  }
}

/** Both addresses reach the same host and port, with TLS on both or neither. */
export function isPlainFleetEndpointPair(environment: ServerFleetEnvironment): boolean {
  const http = parsePlainUrl(environment.httpBaseUrl);
  const ws = parsePlainUrl(environment.wsBaseUrl);
  if (http === null || ws === null) return false;
  const secure = http.protocol === "https:";
  if (!secure && http.protocol !== "http:") return false;
  return ws.protocol === (secure ? "wss:" : "ws:") && ws.host === http.host;
}

export function decodeFleetEnrollment(
  bytes: Uint8Array,
): Result.Result<FleetEnrollment, FleetEnrollmentDecodeError> {
  if (bytes.byteLength > FLEET_ENROLLMENT_MAX_BYTES) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "too-large" }));
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "malformed" }));
  }
  const document = decodeDocument(json);
  if (Result.isFailure(document)) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "malformed" }));
  }
  const { anchor, credential, expiresAt } = document.success;
  if (!isPlainFleetEndpointPair(anchor)) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "unsafe-url" }));
  }
  return Result.succeed({ anchor, credential, expiresAt });
}

/** Produces plaintext for the encryptor; never write these bytes to a file. */
export function encodeFleetEnrollment(
  enrollment: FleetEnrollment,
): Result.Result<Uint8Array, FleetEnrollmentDecodeError> {
  const document = encodeDocument({
    version: 1,
    type: "t3code.fleet-enrollment",
    ...enrollment,
  });
  if (Result.isFailure(document)) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "malformed" }));
  }
  if (!isPlainFleetEndpointPair(enrollment.anchor)) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "unsafe-url" }));
  }
  const bytes = new TextEncoder().encode(JSON.stringify(document.success));
  if (bytes.byteLength > FLEET_ENROLLMENT_MAX_BYTES) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "too-large" }));
  }
  return Result.succeed(bytes);
}
