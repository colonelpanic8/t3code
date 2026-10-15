import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendMode from "./DesktopBackendMode.ts";

const backendModeLayer = (argv: readonly string[], settings?: DesktopAppSettings.DesktopSettings) =>
  DesktopBackendMode.layerTest(argv).pipe(
    Layer.provideMerge(DesktopAppSettings.layerTest(settings)),
  );

const unexpectedProbe = Effect.die("existing-server discovery should not run");

describe("DesktopBackendMode", () => {
  it.effect("lets a CLI override win without probing for an existing server", () =>
    Effect.gen(function* () {
      const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
      assert.deepEqual(yield* backendMode.decide(unexpectedProbe), {
        effectiveMode: "client-only",
        configuredMode: "managed",
        cliOverride: "client-only",
        source: "cli",
      });
      assert.isFalse(yield* backendMode.localEnvironmentEnabled);
    }).pipe(
      Effect.provide(backendModeLayer(["electron", "main.cjs", "--backend-mode=client-only"])),
    ),
  );

  it.effect("accepts a separate flag value", () =>
    Effect.gen(function* () {
      const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
      const state = yield* backendMode.decide(unexpectedProbe);
      assert.equal(state.effectiveMode, "managed");
      assert.equal(state.source, "cli");
    }).pipe(
      Effect.provide(
        backendModeLayer(["electron", "--backend-mode", "managed"], {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: false,
        }),
      ),
    ),
  );

  it.effect("skips discovery when the settings already choose client-only", () =>
    Effect.gen(function* () {
      const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
      assert.equal((yield* backendMode.decide(unexpectedProbe)).source, "settings");
    }).pipe(
      Effect.provide(
        backendModeLayer([], {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled: false,
        }),
      ),
    ),
  );

  it.effect("attaches to an existing server until the setting is turned off", () =>
    Effect.gen(function* () {
      const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      assert.deepEqual(yield* backendMode.decide(Effect.succeed(true)), {
        effectiveMode: "client-only",
        configuredMode: "managed",
        cliOverride: null,
        source: "existing-server",
      });

      yield* appSettings.setLocalEnvironmentEnabled(false);
      assert.equal((yield* backendMode.get).source, "settings");
    }).pipe(Effect.provide(backendModeLayer([]))),
  );

  it.each([
    ["--backend-mode=other", "invalid-value"],
    ["--backend-mode=", "missing-value"],
    ["--backend-mode", "missing-value"],
  ])("rejects invalid launch argument %s", (argument, reason) => {
    const result = DesktopBackendMode.parseDesktopBackendModeOverride(["electron", argument]);
    assert(Result.isFailure(result));
    assert.equal(result.failure.reason, reason);
  });

  it("rejects repeated overrides", () => {
    const result = DesktopBackendMode.parseDesktopBackendModeOverride([
      "--backend-mode=managed",
      "--backend-mode=client-only",
    ]);
    assert(Result.isFailure(result));
    assert.equal(result.failure.reason, "repeated");
  });
});
