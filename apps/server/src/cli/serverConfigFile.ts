/**
 * The server config file (`server.json` in the server config dir by default):
 * daemon options a server reads once at startup. Flags, environment
 * variables, and the desktop bootstrap all rank above it.
 */
import { NonNegativeInt, PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import { OtlpProtocol } from "@t3tools/shared/observability";
import { formatSchemaError, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { RuntimeMode } from "../config.ts";
import { expandHomePath } from "../os-jank.ts";

const LogLevelSchema = Schema.Literals(LogLevel.values);

export const ServerConfigFile = Schema.Struct({
  port: Schema.optionalKey(PortSchema),
  host: Schema.optionalKey(TrimmedNonEmptyString),
  mode: Schema.optionalKey(RuntimeMode),
  noBrowser: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(PortSchema),
  logLevel: Schema.optionalKey(LogLevelSchema),
  logWebSocketEvents: Schema.optionalKey(Schema.Boolean),
  traceFile: Schema.optionalKey(TrimmedNonEmptyString),
  traceMinLevel: Schema.optionalKey(LogLevelSchema),
  traceTimingEnabled: Schema.optionalKey(Schema.Boolean),
  traceBatchWindowMs: Schema.optionalKey(NonNegativeInt),
  traceMaxBytes: Schema.optionalKey(NonNegativeInt),
  traceMaxFiles: Schema.optionalKey(NonNegativeInt),
  otlpTracesUrl: Schema.optionalKey(TrimmedNonEmptyString),
  otlpMetricsUrl: Schema.optionalKey(TrimmedNonEmptyString),
  otlpLogsUrl: Schema.optionalKey(TrimmedNonEmptyString),
  otlpProtocol: Schema.optionalKey(OtlpProtocol),
  otlpHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  otlpExportIntervalMs: Schema.optionalKey(NonNegativeInt),
});
export type ServerConfigFile = typeof ServerConfigFile.Type;

const decodeDocument = Schema.decodeUnknownExit(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeServerConfigFile = Schema.decodeUnknownExit(ServerConfigFile);
const knownKeys: ReadonlySet<string> = new Set(Object.keys(ServerConfigFile.fields));

const allowedValues: Partial<Record<keyof ServerConfigFile, ReadonlyArray<string>>> = {
  mode: RuntimeMode.literals,
  logLevel: LogLevel.values,
  traceMinLevel: LogLevel.values,
  otlpProtocol: OtlpProtocol.literals,
};

// Names the allowed values for a bad enum key, never the value itself.
const describeAllowedValues = (document: Readonly<Record<string, unknown>>) =>
  Object.entries(allowedValues).flatMap(([key, values]) =>
    key in document && !values.some((value) => value === document[key])
      ? [`${key} must be one of: ${values.join(", ")}`]
      : [],
  );

export class ServerConfigFileError extends Schema.TaggedError<ServerConfigFileError>()(
  "ServerConfigFileError",
  { path: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid server config file ${this.path}: ${this.detail}`;
  }
}

/**
 * Reads the server config file. A missing file reads as empty unless it was
 * named explicitly. traceFile comes back absolute, resolved against the
 * file's directory. Unknown keys are ignored with a warning, as settings.json
 * ignores them, so a file written for a newer release still starts an older one.
 */
export const readServerConfigFile = Effect.fn("readServerConfigFile")(function* (
  filePath: string,
  options: { readonly explicit: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound" && !options.explicit
          ? Effect.succeedNone
          : Effect.fail(
              new ServerConfigFileError({
                path: filePath,
                detail:
                  cause.reason._tag === "NotFound" ? "the file does not exist" : cause.message,
              }),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return {} satisfies ServerConfigFile;
  }

  const document = decodeDocument(raw.value);
  if (Exit.isFailure(document)) {
    return yield* new ServerConfigFileError({ path: filePath, detail: "not a JSON object" });
  }
  const decoded = decodeServerConfigFile(document.value);
  if (Exit.isFailure(decoded)) {
    return yield* new ServerConfigFileError({
      path: filePath,
      detail: [formatSchemaError(decoded.cause), ...describeAllowedValues(document.value)].join(
        "\n",
      ),
    });
  }
  const unknownKeys = Object.keys(document.value).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    yield* Effect.logWarning("ignoring unknown keys in the server config file", {
      path: filePath,
      keys: unknownKeys,
    });
  }

  const { traceFile } = decoded.value;
  return (
    traceFile === undefined
      ? decoded.value
      : {
          ...decoded.value,
          traceFile: path.resolve(path.dirname(filePath), yield* expandHomePath(traceFile)),
        }
  ) satisfies ServerConfigFile;
});
