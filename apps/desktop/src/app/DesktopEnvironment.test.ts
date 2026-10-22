import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;
const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );
const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));
describe("DesktopEnvironment", () => {
  it.effect("keeps desktop client files in T3CODE_CLIENT_DIR, apart from server state", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3-server",
          T3CODE_CLIENT_DIR: " /tmp/t3-client ",
        },
      );
      assert.equal(environment.stateDir, "/tmp/t3-server/userdata");
      assert.equal(environment.serverSettingsPath, "/tmp/t3-server/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/t3-server/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3-server/userdata/browser-artifacts");
      assert.equal(environment.clientConfigDir, "/tmp/t3-client");
      assert.equal(environment.clientStateDir, "/tmp/t3-client");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3-client/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/t3-client/client-settings.json");
      assert.equal(environment.desktopWindowStatePath, "/tmp/t3-client/desktop-window-state.json");
      assert.equal(environment.connectionCatalogPath, "/tmp/t3-client/connection-catalog.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/t3-client/saved-environments.json",
      );
    }),
  );
  it.effect("prefers --client-dir over T3CODE_CLIENT_DIR", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {
          clientDirSwitch: "/tmp/t3-client-flag",
        },
        {
          T3CODE_HOME: "/tmp/t3-server",
          T3CODE_CLIENT_DIR: "/tmp/t3-client-env",
        },
      );
      assert.equal(environment.stateDir, "/tmp/t3-server/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3-client-flag/desktop-settings.json");
      assert.equal(
        environment.connectionCatalogPath,
        "/tmp/t3-client-flag/connection-catalog.json",
      );
    }),
  );
  it.effect("expands ~ in --client-dir against the home directory", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        clientDirSwitch: "~/c",
      });
      assert.equal(environment.clientConfigDir, "/Users/alice/c");
      assert.equal(environment.desktopSettingsPath, "/Users/alice/c/desktop-settings.json");
    }),
  );
  it.effect("resolves a relative T3CODE_CLIENT_DIR against the working directory", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_CLIENT_DIR: "t3-client",
        },
      );
      assert.equal(
        environment.desktopSettingsPath,
        `${process.cwd()}/t3-client/desktop-settings.json`,
      );
    }),
  );
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });
      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );
  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        {
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );
      const production = yield* makeEnvironment();
      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});
