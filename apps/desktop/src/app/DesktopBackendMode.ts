import {
  type DesktopBackendMode as DesktopBackendModeValue,
  type DesktopBackendModeState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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

function parseBackendMode(value: string | undefined): DesktopBackendModeValue {
  if (value === undefined || value.length === 0) {
    throw new DesktopBackendModeArgumentError({
      value: value ?? null,
      reason: "missing-value",
    });
  }
  if (value === "managed" || value === "client-only") {
    return value;
  }
  throw new DesktopBackendModeArgumentError({
    value,
    reason: "invalid-value",
  });
}

export function parseDesktopBackendModeOverride(
  argv: readonly string[],
): DesktopBackendModeValue | null {
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
      throw new DesktopBackendModeArgumentError({
        value: value ?? null,
        reason: "repeated",
      });
    }
    override = parseBackendMode(value);
  }

  return override;
}

/**
 * The persisted preference is the local environment setting. A `--backend-mode`
 * launch argument overrides it for one launch, and a packaged launch that finds
 * a live server already owning its state directory attaches to that server
 * instead of starting a second backend against the same database.
 */
export function resolveDesktopBackendModeState(input: {
  readonly localEnvironmentEnabled: boolean;
  readonly cliOverride: DesktopBackendModeValue | null;
  readonly existingServer: boolean;
}): DesktopBackendModeState {
  const configuredMode = input.localEnvironmentEnabled ? "managed" : "client-only";
  if (input.cliOverride !== null) {
    return {
      effectiveMode: input.cliOverride,
      configuredMode,
      cliOverride: input.cliOverride,
      source: "cli",
    };
  }
  if (input.existingServer && configuredMode === "managed") {
    return {
      effectiveMode: "client-only",
      configuredMode,
      cliOverride: null,
      source: "existing-server",
    };
  }
  return { effectiveMode: configuredMode, configuredMode, cliOverride: null, source: "settings" };
}

interface LaunchOverrides {
  readonly cliOverride: DesktopBackendModeValue | null;
  readonly existingServer: boolean;
}

export class DesktopBackendMode extends Context.Service<
  DesktopBackendMode,
  {
    // Reads the launch arguments. Run once at startup, before anything
    // decides whether to start the local backend.
    readonly latchCliOverride: Effect.Effect<
      DesktopBackendModeState,
      DesktopBackendModeArgumentError
    >;
    // Records that a live server already owns this app's state directory.
    readonly useExistingServer: Effect.Effect<DesktopBackendModeState>;
    readonly get: Effect.Effect<DesktopBackendModeState>;
    // Whether this launch runs its own local backend.
    readonly localEnvironmentEnabled: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopBackendMode") {}

export const make = Effect.fn("desktop.backendMode.make")(function* (argv: readonly string[]) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const overridesRef = yield* Ref.make<LaunchOverrides>({
    cliOverride: null,
    existingServer: false,
  });

  const get = Effect.gen(function* () {
    const overrides = yield* Ref.get(overridesRef);
    const { localEnvironmentEnabled } = yield* appSettings.get;
    return resolveDesktopBackendModeState({ localEnvironmentEnabled, ...overrides });
  });

  return DesktopBackendMode.of({
    latchCliOverride: Effect.try({
      try: () => parseDesktopBackendModeOverride(argv),
      catch: (cause) =>
        isDesktopBackendModeArgumentError(cause)
          ? cause
          : new DesktopBackendModeArgumentError({ value: null, reason: "invalid-value" }),
    }).pipe(
      Effect.tap((cliOverride) => Ref.update(overridesRef, (state) => ({ ...state, cliOverride }))),
      Effect.andThen(get),
    ),
    useExistingServer: Ref.update(overridesRef, (state) => ({
      ...state,
      existingServer: true,
    })).pipe(Effect.andThen(get)),
    get,
    localEnvironmentEnabled: Effect.map(get, (state) => state.effectiveMode === "managed"),
  });
});

export const layer = Layer.effect(DesktopBackendMode, make(process.argv));

export const layerTest = (argv: readonly string[] = []) =>
  Layer.effect(DesktopBackendMode, make(argv));
