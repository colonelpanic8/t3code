// @effect-diagnostics nodeBuiltinImport:off - the pre-ready password-store read uses synchronous Node IO.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopWindowState from "../window/DesktopWindowState.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import { resolveEarlyLinuxPasswordStorePreference } from "./DesktopEarlyElectronStartup.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const layerSafeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(textEncoder.encode(value)),
  decryptString: (value) => Effect.succeed(textDecoder.decode(value)),
  selectedStorageBackend: Effect.succeedNone,
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const layerClientFiles = (serverHome: string, clientDir: string) => {
  const layerDependencies = Layer.mergeAll(
    DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: serverHome,
      platform: "linux",
      processArch: "x64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopConfig.layerTest({ T3CODE_HOME: serverHome, T3CODE_CLIENT_DIR: clientDir }),
        ),
      ),
    ),
    layerSafeStorage,
    NodeServices.layer,
  );
  return Layer.mergeAll(
    DesktopWindowState.layer.pipe(Layer.provideMerge(DesktopAppSettings.layer)),
    DesktopClientSettings.layer,
    DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(DesktopSavedEnvironments.layer)),
  ).pipe(Layer.provideMerge(layerDependencies));
};

describe("desktop client directory", () => {
  it.effect("keeps every desktop client file in the client directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-server-home-",
      });
      const clientDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-client-dir-",
      });
      yield* fileSystem.writeFileString(
        `${clientDir}/desktop-settings.json`,
        '{"updateChannel":"nightly","linuxPasswordStore":"kwallet6"}\n',
      );

      yield* Effect.gen(function* () {
        const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
        const windowState = yield* DesktopWindowState.DesktopWindowState;
        assert.equal((yield* desktopSettings.load).updateChannel, "nightly");
        yield* windowState.setMainWindowBounds({ x: 10, y: 20, width: 1200, height: 800 }, false);
        yield* (yield* DesktopClientSettings.DesktopClientSettings).set(DEFAULT_CLIENT_SETTINGS);
        assert.isTrue(
          yield* (yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore).set(
            '{"schemaVersion":1,"targets":[]}',
          ),
        );
      }).pipe(Effect.provide(layerClientFiles(serverHome, clientDir)));

      assert.deepEqual((yield* fileSystem.readDirectory(clientDir)).toSorted(), [
        "client-settings.json",
        "connection-catalog.json",
        "desktop-settings.json",
        "desktop-window-state.json",
      ]);
      assert.deepEqual(yield* fileSystem.readDirectory(serverHome), []);
      assert.equal(
        resolveEarlyLinuxPasswordStorePreference({
          env: { T3CODE_HOME: serverHome, T3CODE_CLIENT_DIR: clientDir },
          clientDirSwitch: null,
          homeDirectory: "/home/user",
          joinPath: NodePath.posix.join,
          readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
        }),
        "kwallet6",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
