import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendMode from "./DesktopBackendMode.ts";

describe("DesktopBackendMode", () => {
  const captureThrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the operation to throw.");
  };

  it("follows the local environment setting without overrides", () => {
    assert.deepEqual(
      DesktopBackendMode.resolveDesktopBackendModeState({
        localEnvironmentEnabled: false,
        cliOverride: null,
        existingServer: false,
      }),
      {
        effectiveMode: "client-only",
        configuredMode: "client-only",
        cliOverride: null,
        source: "settings",
      },
    );
  });

  it("gives the CLI override precedence without changing the configured mode", () => {
    assert.deepEqual(
      DesktopBackendMode.resolveDesktopBackendModeState({
        localEnvironmentEnabled: true,
        cliOverride: DesktopBackendMode.parseDesktopBackendModeOverride([
          "electron",
          "main.cjs",
          "--backend-mode=client-only",
        ]),
        existingServer: true,
      }),
      {
        effectiveMode: "client-only",
        configuredMode: "managed",
        cliOverride: "client-only",
        source: "cli",
      },
    );
  });

  it("accepts a separate flag value", () => {
    assert.equal(
      DesktopBackendMode.parseDesktopBackendModeOverride(["electron", "--backend-mode", "managed"]),
      "managed",
    );
  });

  it("attaches to an already running server instead of starting another backend", () => {
    expect(
      DesktopBackendMode.resolveDesktopBackendModeState({
        localEnvironmentEnabled: true,
        cliOverride: null,
        existingServer: true,
      }),
    ).toEqual({
      effectiveMode: "client-only",
      configuredMode: "managed",
      cliOverride: null,
      source: "existing-server",
    });
  });

  it.effect("reads the saved setting live and keeps launch overrides", () =>
    Effect.gen(function* () {
      const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      assert.isTrue(yield* backendMode.localEnvironmentEnabled);

      yield* backendMode.useExistingServer;
      assert.isFalse(yield* backendMode.localEnvironmentEnabled);

      yield* appSettings.setLocalEnvironmentEnabled(false);
      assert.equal((yield* backendMode.get).source, "settings");
    }).pipe(
      Effect.provide(
        DesktopBackendMode.layerTest().pipe(Layer.provideMerge(DesktopAppSettings.layerTest())),
      ),
    ),
  );

  it.each([
    ["--backend-mode=other", "invalid-value"],
    ["--backend-mode=", "missing-value"],
    ["--backend-mode", "missing-value"],
  ])("rejects invalid launch argument %s", (argument, reason) => {
    const error = captureThrown(() =>
      DesktopBackendMode.parseDesktopBackendModeOverride(["electron", argument]),
    );
    assert.isTrue(DesktopBackendMode.isDesktopBackendModeArgumentError(error));
    if (DesktopBackendMode.isDesktopBackendModeArgumentError(error)) {
      assert.equal(error.reason, reason);
    }
  });

  it("rejects repeated overrides", () => {
    const error = captureThrown(() =>
      DesktopBackendMode.parseDesktopBackendModeOverride([
        "--backend-mode=managed",
        "--backend-mode=client-only",
      ]),
    );
    assert.isTrue(DesktopBackendMode.isDesktopBackendModeArgumentError(error));
    if (DesktopBackendMode.isDesktopBackendModeArgumentError(error)) {
      assert.equal(error.reason, "repeated");
    }
  });
});
