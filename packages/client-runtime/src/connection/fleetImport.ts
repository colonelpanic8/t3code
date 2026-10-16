import {
  EnvironmentId,
  TrimmedNonEmptyString,
  type ServerFleetEnvironment,
} from "@t3tools/contracts";
import { isPlainFleetEndpointPair } from "@t3tools/shared/fleetEnrollment";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A fleet file is the non-secret manifest an operator generates for the
 * machines of one fleet, in the same shape servers read. A client imports it
 * to list the fleet and pair one member at its declared address. It grants
 * nothing, so it is decoded strictly: unknown keys, such as a token, and URLs
 * that could carry a credential are rejected rather than ignored. Errors never
 * repeat the file's contents.
 */

export const FLEET_IMPORT_MAX_BYTES = 64 * 1024;
export const FLEET_IMPORT_MAX_ENVIRONMENTS = 100;

const FleetImportDocument = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: TrimmedNonEmptyString,
      httpBaseUrl: Schema.String,
      wsBaseUrl: Schema.String,
    }),
  ),
});
const decodeDocument = Schema.decodeUnknownResult(FleetImportDocument, {
  onExcessProperty: "error",
});

export class FleetImportError extends Schema.TaggedError<FleetImportError>()("FleetImportError", {
  reason: Schema.Literals([
    "too-large",
    "malformed",
    "empty",
    "too-many",
    "duplicate-environment",
    "unsafe-url",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return "That fleet file is too large.";
      case "malformed":
        return "That file is not a T3 Code fleet file.";
      case "empty":
        return "That fleet file lists no environments.";
      case "too-many":
        return `A fleet file can list at most ${FLEET_IMPORT_MAX_ENVIRONMENTS} environments.`;
      case "duplicate-environment":
        return "That fleet file lists an environment more than once.";
      case "unsafe-url":
        return "That fleet file has an address that is not a plain server URL.";
    }
  }
}

/** Decodes a fleet file's bytes or text into the environments it declares. */
export function decodeFleetImport(
  source: Uint8Array | string,
): Result.Result<ReadonlyArray<ServerFleetEnvironment>, FleetImportError> {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  if (bytes.byteLength > FLEET_IMPORT_MAX_BYTES) {
    return Result.fail(new FleetImportError({ reason: "too-large" }));
  }

  let json: unknown;
  try {
    json = JSON.parse(typeof source === "string" ? source : new TextDecoder().decode(source));
  } catch {
    return Result.fail(new FleetImportError({ reason: "malformed" }));
  }
  const document = decodeDocument(json);
  if (Result.isFailure(document)) {
    return Result.fail(new FleetImportError({ reason: "malformed" }));
  }

  const { environments } = document.success;
  if (environments.length === 0) {
    return Result.fail(new FleetImportError({ reason: "empty" }));
  }
  if (environments.length > FLEET_IMPORT_MAX_ENVIRONMENTS) {
    return Result.fail(new FleetImportError({ reason: "too-many" }));
  }
  if (
    new Set(environments.map((environment) => environment.environmentId)).size !==
    environments.length
  ) {
    return Result.fail(new FleetImportError({ reason: "duplicate-environment" }));
  }
  if (!environments.every(isPlainFleetEndpointPair)) {
    return Result.fail(new FleetImportError({ reason: "unsafe-url" }));
  }
  return Result.succeed(environments);
}
