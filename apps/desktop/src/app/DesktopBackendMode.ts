import {
  type DesktopBackendMode as DesktopBackendModeValue,
  type DesktopBackendModeState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const BACKEND_MODE_FLAG = "--backend-mode";

export class DesktopBackendModeArgumentError extends Schema.TaggedError<DesktopBackendModeArgumentError>()(
  "DesktopBackendModeArgumentError",
  {
    value: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["missing-value", "invalid-value", "repeated"]),
  },
) {
  override get message(): string {
    if (this.reason === "missing-value") {
      return `${BACKEND_MODE_FLAG} requires either "managed" or "client-only".`;
    }
    if (this.reason === "repeated") {
      return `${BACKEND_MODE_FLAG} may only be specified once.`;
    }
    return `Invalid ${BACKEND_MODE_FLAG} value ${JSON.stringify(this.value)}. Expected "managed" or "client-only".`;
  }
}

export const isDesktopBackendModeArgumentError = Schema.is(DesktopBackendModeArgumentError);

function parseBackendMode(
  value: string | undefined,
): Result.Result<DesktopBackendModeValue, DesktopBackendModeArgumentError> {
  if (value === "managed" || value === "client-only") {
    return Result.succeed(value);
  }
  return Result.fail(
    new DesktopBackendModeArgumentError({
      value: value ?? null,
      reason: value === undefined || value.length === 0 ? "missing-value" : "invalid-value",
    }),
  );
}

export function parseDesktopBackendModeOverride(
  argv: readonly string[],
): Result.Result<DesktopBackendModeValue | null, DesktopBackendModeArgumentError> {
  let override: DesktopBackendModeValue | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    let value: string | undefined;
    if (argument === BACKEND_MODE_FLAG) {
      value = argv[index + 1];
      index += 1;
    } else if (argument.startsWith(`${BACKEND_MODE_FLAG}=`)) {
      value = argument.slice(BACKEND_MODE_FLAG.length + 1);
    } else {
      continue;
    }

    if (override !== null) {
      return Result.fail(
        new DesktopBackendModeArgumentError({ value: value ?? null, reason: "repeated" }),
      );
    }
    const parsed = parseBackendMode(value);
    if (Result.isFailure(parsed)) return parsed;
    override = parsed.success;
  }

  return Result.succeed(override);
}

export type DesktopBackendModeOverride =
  | { readonly source: "cli"; readonly mode: DesktopBackendModeValue }
  | { readonly source: "existing-server" };

/**
 * The persisted preference is the local environment setting. A `--backend-mode`
 * launch argument overrides it for one launch, and a packaged launch that finds
 * a live server already owning its state directory attaches to that server
 * instead of starting a second backend against the same database.
 */
export function resolveDesktopBackendModeState(input: {
  readonly localEnvironmentEnabled: boolean;
  readonly override: DesktopBackendModeOverride | null;
}): DesktopBackendModeState {
  const configuredMode = input.localEnvironmentEnabled ? "managed" : "client-only";
  const { override } = input;
  if (override?.source === "cli") {
    return {
      effectiveMode: override.mode,
      configuredMode,
      cliOverride: override.mode,
      source: "cli",
    };
  }
  if (override?.source === "existing-server" && configuredMode === "managed") {
    return {
      effectiveMode: "client-only",
      configuredMode,
      cliOverride: null,
      source: "existing-server",
    };
  }
  return { effectiveMode: configuredMode, configuredMode, cliOverride: null, source: "settings" };
}

export class DesktopBackendMode extends Context.Service<
  DesktopBackendMode,
  {
    // Decides this launch's override once, before anything starts the local
    // backend. `--backend-mode` wins; otherwise `hasExistingServer` runs only
    // when the settings would start a backend.
    readonly decide: (
      hasExistingServer: Effect.Effect<boolean>,
    ) => Effect.Effect<DesktopBackendModeState, DesktopBackendModeArgumentError>;
    readonly get: Effect.Effect<DesktopBackendModeState>;
    // Whether this launch runs its own local backend.
    readonly localEnvironmentEnabled: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopBackendMode") {}

export const make = Effect.fn("desktop.backendMode.make")(function* (argv: readonly string[]) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const overrideRef = yield* Ref.make<DesktopBackendModeOverride | null>(null);

  const get = Effect.gen(function* () {
    const override = yield* Ref.get(overrideRef);
    const { localEnvironmentEnabled } = yield* appSettings.get;
    return resolveDesktopBackendModeState({ localEnvironmentEnabled, override });
  });

  const decide = Effect.fn("desktop.backendMode.decide")(function* (
    hasExistingServer: Effect.Effect<boolean>,
  ) {
    const cliMode = yield* Effect.fromResult(parseDesktopBackendModeOverride(argv));
    if (cliMode !== null) {
      yield* Ref.set(overrideRef, { source: "cli", mode: cliMode });
    } else if ((yield* appSettings.get).localEnvironmentEnabled && (yield* hasExistingServer)) {
      yield* Ref.set(overrideRef, { source: "existing-server" });
    }
    return yield* get;
  });

  return DesktopBackendMode.of({
    decide,
    get,
    localEnvironmentEnabled: Effect.map(get, (state) => state.effectiveMode === "managed"),
  });
});

export const layer = Layer.effect(DesktopBackendMode, make(process.argv));

export const layerTest = (argv: readonly string[] = []) =>
  Layer.effect(DesktopBackendMode, make(argv));
