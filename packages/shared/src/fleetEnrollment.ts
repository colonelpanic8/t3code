import { ServerFleetEnvironment } from "@t3tools/contracts";
import type * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A fleet enrollment is one plaintext document listing, per machine, an
 * independent reusable enrollment credential for that machine. A device
 * redeems each credential at its own machine, so the document is the whole
 * membership: no machine vouches for another. `t3 auth enrollment export`
 * writes a one-entry document; concatenating the `environments` of several
 * exports and re-encrypting them yields a bundle.
 */

export const FLEET_ENROLLMENT_MAX_BYTES = 64 * 1024;
export const FLEET_ENROLLMENT_MAX_ENVIRONMENTS = 100;

export const FleetEnrollmentCredential = Schema.String.check(
  Schema.isPattern(/^t3enroll1\.[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("FleetEnrollmentCredential"));
export type FleetEnrollmentCredential = typeof FleetEnrollmentCredential.Type;

/** Routes the reserved prefix; the credential schema validates the full value. */
export const isFleetEnrollmentCredential = (value: string): boolean =>
  value.startsWith("t3enroll1.");

export interface FleetEnrollmentEntry {
  readonly environment: ServerFleetEnvironment;
  readonly credential: Redacted.Redacted<FleetEnrollmentCredential>;
  readonly expiresAt: DateTime.Utc;
}

export interface FleetEnrollment {
  readonly environments: Arr.NonEmptyReadonlyArray<FleetEnrollmentEntry>;
}

const WireEntry = Schema.Struct({
  ...ServerFleetEnvironment.fields,
  // Plain strings, so a bad address reports as unsafe rather than malformed.
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  credential: Schema.RedactedFromValue(FleetEnrollmentCredential),
  expiresAt: Schema.DateTimeUtcFromString,
});

const EnrollmentDocument = Schema.Struct({
  version: Schema.Literal(2),
  type: Schema.Literal("t3code.fleet-enrollment"),
  environments: Schema.NonEmptyArray(WireEntry).check(
    Schema.isMaxLength(FLEET_ENROLLMENT_MAX_ENVIRONMENTS),
  ),
});
const decodeDocument = Schema.decodeUnknownResult(EnrollmentDocument, {
  onExcessProperty: "error",
});
const encodeDocument = Schema.encodeUnknownResult(EnrollmentDocument);

export class FleetEnrollmentDecodeError extends Schema.TaggedError<FleetEnrollmentDecodeError>()(
  "FleetEnrollmentDecodeError",
  { reason: Schema.Literals(["too-large", "malformed", "unsafe-url", "duplicate-environment"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return "That fleet enrollment file is too large.";
      case "malformed":
        return "That file is not a T3 Code fleet enrollment file.";
      case "unsafe-url":
        return "That fleet enrollment file has an address that is not a plain server origin.";
      case "duplicate-environment":
        return "That fleet enrollment file lists a machine more than once.";
    }
  }
}

// Exclude URL syntax that can carry credentials or change authority parsing.
const UNSAFE_URL_CHARACTER = /[\p{Cc}\s\\?#@]/u;

function parsePlainOrigin(value: string): URL | null {
  if (UNSAFE_URL_CHARACTER.test(value)) return null;
  try {
    const url = new URL(value);
    return value.toLowerCase().startsWith(`${url.protocol}//`) && url.pathname === "/" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Both addresses are bare origins of the same host and port, with TLS on both
 * or neither. Credentials are only redeemed at the origin's `/oauth/token`.
 */
export function isPlainFleetOriginPair(environment: ServerFleetEnvironment): boolean {
  const http = parsePlainOrigin(environment.httpBaseUrl);
  const ws = parsePlainOrigin(environment.wsBaseUrl);
  if (http === null || ws === null) return false;
  const secure = http.protocol === "https:";
  if (!secure && http.protocol !== "http:") return false;
  return ws.protocol === (secure ? "wss:" : "ws:") && ws.host === http.host;
}

function checkEnvironments(
  entries: ReadonlyArray<FleetEnrollmentEntry>,
): Result.Result<void, FleetEnrollmentDecodeError> {
  if (!entries.every((entry) => isPlainFleetOriginPair(entry.environment))) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "unsafe-url" }));
  }
  const ids = new Set(entries.map((entry) => entry.environment.environmentId));
  if (ids.size !== entries.length) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "duplicate-environment" }));
  }
  return Result.void;
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
  const [first, ...rest] = document.success.environments;
  const toEntry = ({ credential, expiresAt, ...environment }: typeof WireEntry.Type) => ({
    environment,
    credential,
    expiresAt,
  });
  const enrollment: FleetEnrollment = { environments: [toEntry(first), ...rest.map(toEntry)] };
  return Result.map(checkEnvironments(enrollment.environments), () => enrollment);
}

/** Produces plaintext for the encryptor; never write these bytes to a file. */
export function encodeFleetEnrollment(
  enrollment: FleetEnrollment,
): Result.Result<Uint8Array, FleetEnrollmentDecodeError> {
  const checked = checkEnvironments(enrollment.environments);
  if (Result.isFailure(checked)) return Result.fail(checked.failure);
  const document = encodeDocument({
    version: 2,
    type: "t3code.fleet-enrollment",
    environments: enrollment.environments.map((entry) => ({
      ...entry.environment,
      credential: entry.credential,
      expiresAt: entry.expiresAt,
    })),
  });
  if (Result.isFailure(document)) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "malformed" }));
  }
  const bytes = new TextEncoder().encode(JSON.stringify(document.success));
  if (bytes.byteLength > FLEET_ENROLLMENT_MAX_BYTES) {
    return Result.fail(new FleetEnrollmentDecodeError({ reason: "too-large" }));
  }
  return Result.succeed(bytes);
}
