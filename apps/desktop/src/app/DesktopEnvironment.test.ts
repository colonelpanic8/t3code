import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  selectT3Storage,
  T3StorageConfigurationError,
  t3StoragePathExists,
} from "@t3tools/shared/storagePaths";

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
  it.effect("reads server settings from the server config dir override", () =>
    Effect.gen(function* () {
      const relative = yield* makeEnvironment({}, { T3CODE_SERVER_CONFIG_DIR: "config" });
      assert.equal(relative.serverSettingsPath, "/repo/config/settings.json");
      const home = yield* makeEnvironment(
        { isPackaged: true },
        { T3CODE_HOME: "/Users/alice/.t3", T3CODE_SERVER_CONFIG_DIR: "~/c" },
      );
      assert.equal(home.serverSettingsPath, "/Users/alice/c/settings.json");
      assert.equal(home.stateDir, "/Users/alice/.t3/userdata");
      const split = yield* makeEnvironment({ isPackaged: true }, {});
      assert.equal(
        split.serverSettingsPath,
        "/Users/alice/Library/Application Support/t3code/config/settings.json",
      );
    }),
  );

  it.effect("keeps browser screenshots in the server data dir override the backend prunes", () =>
    Effect.gen(function* () {
      const legacy = yield* makeEnvironment(
        { isPackaged: true },
        { T3CODE_HOME: "/Users/alice/.t3", T3CODE_SERVER_DATA_DIR: "~/t3-data" },
      );
      assert.equal(legacy.browserArtifactsDir, "/Users/alice/t3-data/browser-artifacts");
      const split = yield* makeEnvironment(
        { platform: "linux", homeDirectory: "/home/alice", temporaryDirectory: "/tmp" },
        { XDG_DATA_HOME: "/xdg/data", T3CODE_SERVER_DATA_DIR: "/srv/t3" },
      );
      assert.equal(split.browserArtifactsDir, "/srv/t3/browser-artifacts");
    }),
  );

  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: " /tmp/t3 ",
          T3CODE_MANAGED_CONNECTIONS_FILE: " /run/secrets/t3code-connections.json ",
          T3CODE_COMMIT_HASH: " 0123456789abcdef ",
          T3CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          T3CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          T3CODE_OTLP_METRICS_URL: " http://127.0.0.1:4318/v1/metrics ",
          T3CODE_OTLP_LOGS_URL: " http://127.0.0.1:4318/v1/logs ",
          T3CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
          T3CODE_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=t3",
          T3CODE_OTLP_PROTOCOL: "http/protobuf",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/t3");
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.clientConfigDir, "/tmp/t3/userdata");
      assert.equal(environment.clientStateDir, "/tmp/t3/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/t3/userdata/desktop-settings.json");
      assert.equal(
        environment.desktopWindowStatePath,
        "/tmp/t3/userdata/desktop-window-state.json",
      );
      assert.equal(environment.clientSettingsPath, "/tmp/t3/userdata/client-settings.json");
      assert.equal(environment.connectionCatalogPath, "/tmp/t3/userdata/connection-catalog.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/t3/userdata/saved-environments.json",
      );
      assert.deepEqual(
        environment.managedConnectionsPath,
        Option.some("/run/secrets/t3code-connections.json"),
      );
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.serverRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
      assert.equal(environment.linuxWmClass, "t3code-dev");
      assert.equal(environment.linuxDesktopEntryName, "com.t3tools.T3Code.Development.desktop");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.devRemoteT3ServerEntryPath, Option.some("/remote/server.mjs"));
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.deepEqual(environment.otlpMetricsUrl, Option.some("http://127.0.0.1:4318/v1/metrics"));
      assert.deepEqual(environment.otlpLogsUrl, Option.some("http://127.0.0.1:4318/v1/logs"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
      assert.deepEqual(
        environment.otlpHeaders,
        Option.some({
          authorization: "Basic abc==",
          "x-tenant": "t3",
        }),
      );
      assert.equal(environment.otlpProtocol, "http/protobuf");
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_HOME: "/tmp/t3",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/t3/userdata");
      assert.equal(environment.logDir, "/tmp/t3/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/t3/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/t3/userdata/settings.json");
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("keeps desktop client files in T3CODE_CLIENT_DIR, apart from server state", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        { T3CODE_HOME: "/tmp/t3-server", T3CODE_CLIENT_DIR: " /tmp/t3-client " },
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
        { clientDirSwitch: "/tmp/t3-client-flag" },
        { T3CODE_HOME: "/tmp/t3-server", T3CODE_CLIENT_DIR: "/tmp/t3-client-env" },
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
      const environment = yield* makeEnvironment({ clientDirSwitch: "~/c" });

      assert.equal(environment.clientConfigDir, "/Users/alice/c");
      assert.equal(environment.desktopSettingsPath, "/Users/alice/c/desktop-settings.json");
    }),
  );

  it.effect("splits the desktop's own files by layout and moves them all with a client dir", () =>
    Effect.gen(function* () {
      const linux = {
        platform: "linux" as const,
        homeDirectory: "/home/alice",
        temporaryDirectory: "/tmp",
        userId: 1000,
      };
      const xdg = { XDG_CONFIG_HOME: "/xdg/config", XDG_STATE_HOME: "/xdg/state" };

      const split = yield* makeEnvironment(linux, xdg);
      assert.equal(split.storageLayout, "split");
      assert.equal(split.desktopSettingsPath, "/xdg/config/t3code/desktop-settings.json");
      assert.equal(split.clientSettingsPath, "/xdg/config/t3code/client-settings.json");
      assert.equal(split.desktopWindowStatePath, "/xdg/state/t3code/desktop-window-state.json");
      assert.equal(split.connectionCatalogPath, "/xdg/state/t3code/connection-catalog.json");

      const relocated = yield* makeEnvironment(
        { ...linux, clientDirSwitch: "~/t3-client" },
        { ...xdg, T3CODE_CLIENT_DIR: "/ignored" },
      );
      assert.equal(relocated.storageLayout, "split");
      assert.equal(relocated.clientConfigDir, "/home/alice/t3-client");
      assert.equal(relocated.clientStateDir, "/home/alice/t3-client");
      assert.equal(relocated.desktopSettingsPath, "/home/alice/t3-client/desktop-settings.json");
      assert.equal(
        relocated.desktopWindowStatePath,
        "/home/alice/t3-client/desktop-window-state.json",
      );
      // The server's files and the Electron profile stay with the layout.
      assert.equal(relocated.serverSettingsPath, "/xdg/config/t3code/settings.json");
      assert.equal(relocated.electronUserDataPath, "/xdg/state/t3code/electron");
    }),
  );

  it.effect("resolves a relative T3CODE_CLIENT_DIR against the working directory", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({}, { T3CODE_CLIENT_DIR: "t3-client" });

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

  it.effect("uses the stable desktop entry as the packaged Linux portal identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "linux",
        isPackaged: true,
        appPath: "/tmp/.mount_t3code/resources/app.asar",
        resourcesPath: "/tmp/.mount_t3code/resources",
      });

      assert.equal(environment.linuxDesktopEntryName, "com.t3tools.T3Code.desktop");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(
        development.stateDir,
        "/Users/alice/Library/Application Support/t3code-dev/state",
      );
      assert.equal(production.stateDir, "/Users/alice/Library/Application Support/t3code/state");
      assert.equal(production.configDir, "/Users/alice/Library/Application Support/t3code/config");
      assert.equal(production.dataDir, "/Users/alice/Library/Application Support/t3code/data");
      assert.equal(production.cacheDir, "/Users/alice/Library/Caches/t3code");
      assert.equal(
        production.runtimeDir,
        "/Users/alice/Library/Application Support/t3code/runtime",
      );
    }),
  );

  it.effect("honors all five XDG roots on Linux", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {
          platform: "linux",
          homeDirectory: "/home/alice",
          temporaryDirectory: "/tmp",
          userId: 1000,
        },
        {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
          XDG_STATE_HOME: "/xdg/state",
          XDG_CACHE_HOME: "/xdg/cache",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      );

      assert.equal(environment.storageLayout, "split");
      assert.equal(environment.configDir, "/xdg/config/t3code");
      assert.equal(environment.dataDir, "/xdg/data/t3code");
      assert.equal(environment.stateDir, "/xdg/state/t3code");
      assert.equal(environment.cacheDir, "/xdg/cache/t3code");
      assert.equal(environment.runtimeDir, "/run/user/1000/t3code");
      assert.equal(environment.serverSettingsPath, "/xdg/config/t3code/settings.json");
      // The server prunes these with its own, so both share the data dir.
      assert.equal(environment.browserArtifactsDir, "/xdg/data/t3code/browser-artifacts");
      assert.equal(environment.electronUserDataPath, "/xdg/state/t3code/electron");
    }),
  );

  it.effect("rejects mixing T3CODE_HOME with granular directory overrides", () =>
    Effect.gen(function* () {
      const error = yield* makeEnvironment(
        { platform: "linux", homeDirectory: "/home/alice" },
        {
          T3CODE_HOME: "/tmp/legacy-t3",
          T3CODE_STATE_DIR: "/tmp/t3-state",
        },
      ).pipe(Effect.flip);

      assert.instanceOf(error, T3StorageConfigurationError);
    }),
  );

  it.effect("keeps an initialized legacy installation without copying it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-environment-legacy-",
      });
      const homeDirectory = path.join(root, "home");
      const legacyStateDir = path.join(homeDirectory, ".t3", "userdata");
      const splitStateHome = path.join(root, "state");
      yield* fileSystem.makeDirectory(legacyStateDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(splitStateHome, "t3code"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(legacyStateDir, "state.sqlite"), "legacy");
      yield* fileSystem.writeFileString(path.join(splitStateHome, "t3code", "state.sqlite"), "");

      const environment = yield* makeEnvironment(
        {
          platform: "linux",
          homeDirectory,
          temporaryDirectory: root,
          userId: 1000,
        },
        { XDG_STATE_HOME: splitStateHome },
      );

      assert.equal(environment.storageLayout, "legacy");
      assert.equal(environment.stateDir, legacyStateDir);
      assert.equal(environment.serverSettingsPath, path.join(legacyStateDir, "settings.json"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps legacy storage when only legacy secrets are initialized", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-environment-legacy-secrets-",
      });
      const homeDirectory = path.join(root, "home");
      const legacyStateDir = path.join(homeDirectory, ".t3", "userdata");
      yield* fileSystem.makeDirectory(path.join(legacyStateDir, "secrets"), {
        recursive: true,
      });

      const environment = yield* makeEnvironment({
        platform: "linux",
        homeDirectory,
        temporaryDirectory: root,
        userId: 1000,
      });

      assert.equal(environment.storageLayout, "legacy");
      assert.equal(environment.stateDir, legacyStateDir);
      assert.equal(environment.serverSettingsPath, path.join(legacyStateDir, "settings.json"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { artifactName: "desktop settings", fileName: "desktop-settings.json" },
    { artifactName: "client settings", fileName: "client-settings.json" },
    { artifactName: "saved environments", fileName: "saved-environments.json" },
  ])("keeps legacy storage when only legacy $artifactName are initialized", ({ fileName }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-environment-legacy-settings-",
      });
      const homeDirectory = path.join(root, "home");
      const legacyStateDir = path.join(homeDirectory, ".t3", "userdata");
      yield* fileSystem.makeDirectory(legacyStateDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacyStateDir, fileName), "{}");

      const environment = yield* makeEnvironment({
        platform: "linux",
        homeDirectory,
        temporaryDirectory: root,
        userId: 1000,
      });

      assert.equal(environment.storageLayout, "legacy");
      assert.equal(environment.configDir, legacyStateDir);
      assert.equal(environment.stateDir, legacyStateDir);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not treat Electron preferences as initialized server storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-environment-electron-only-",
      });
      const homeDirectory = path.join(root, "home");
      const electronDirectory = path.join(
        homeDirectory,
        "Library",
        "Application Support",
        "T3 Code (Alpha)",
      );
      yield* fileSystem.makeDirectory(electronDirectory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(electronDirectory, "Local State"), "{}");

      const environment = yield* makeEnvironment({
        homeDirectory,
        temporaryDirectory: root,
      });

      assert.equal(environment.storageLayout, "split");
      assert.equal(
        environment.stateDir,
        path.join(homeDirectory, "Library", "Application Support", "t3code", "state"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_APP_USER_MODEL_ID: " com.t3tools.t3code.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev.local");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );

  it.effect.each([
    { name: "a new install", files: [], env: {} },
    { name: "an initialized ~/.t3", files: [".t3/userdata/settings.json"], env: {} },
    {
      name: "a split install beside a later ~/.t3",
      files: [".t3/userdata/statev2.sqlite", "state/t3code/statev2.sqlite"],
      env: {},
    },
    { name: "selectors", files: [], env: { T3CODE_CONFIG_DIR: "~/dotfiles/t3code" } },
    {
      name: "T3CODE_HOME with a server override",
      files: [],
      env: { T3CODE_HOME: "~/t3", T3CODE_SERVER_CONFIG_DIR: "/etc/t3" },
    },
  ])("picks the shared selector's roots for $name", ({ files, env }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-same-roots-" });
      const home = path.join(root, "home");
      const xdg = {
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CONFIG_HOME: path.join(home, "config"),
      };
      for (const file of files) {
        const target = path.join(home, file);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, "");
      }

      const environment = yield* makeEnvironment(
        { platform: "linux", homeDirectory: home, temporaryDirectory: root, userId: 1000 },
        { ...xdg, ...env },
      );
      const selection = selectT3Storage({
        platform: "linux",
        homeDirectory: home,
        temporaryDirectory: root,
        userId: 1000,
        isDevelopment: false,
        environment: { ...xdg, ...env },
        path,
        exists: t3StoragePathExists,
      });

      assert.deepEqual(selection._tag === "Selected" && selection.roots, environment.storageRoots);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
