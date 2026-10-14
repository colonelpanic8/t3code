import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindowState from "./DesktopWindowState.ts";

const layerWindowState = (baseDir: string) =>
  DesktopWindowState.layer.pipe(
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "linux",
        processArch: "x64",
        appVersion: "0.0.17",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: baseDir }))),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

// Each call builds fresh services over the same files, like an app restart.
const startApp = (baseDir: string) =>
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const windowState = yield* DesktopWindowState.DesktopWindowState;
    yield* settings.load;
    return yield* windowState.load;
  }).pipe(Effect.provide(layerWindowState(baseDir)));

const withBaseDir = <A, E, R>(f: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-window-state-test-",
    });
    yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
    return yield* f(baseDir);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopWindowState", () => {
  it.effect("moving the window leaves a symlinked desktop-settings.json untouched", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-window-state-dotfiles-",
        });
        const linkedSettingsPath = `${dotfiles}/desktop-settings.json`;
        const dotfilesContents = '{\n  "updateChannel": "nightly"\n}\n';
        yield* fileSystem.writeFileString(linkedSettingsPath, dotfilesContents);
        yield* fileSystem.symlink(linkedSettingsPath, `${baseDir}/userdata/desktop-settings.json`);

        yield* Effect.gen(function* () {
          const windowState = yield* DesktopWindowState.DesktopWindowState;
          yield* (yield* DesktopAppSettings.DesktopAppSettings).load;
          yield* windowState.load;
          yield* windowState.setMainWindowBounds({ x: 10, y: 20, width: 1200, height: 800 }, false);
          yield* windowState.setMainWindowBounds(
            { x: 300, y: 40, width: 1200, height: 800 },
            false,
          );
        }).pipe(Effect.provide(layerWindowState(baseDir)));

        assert.equal(yield* fileSystem.readFileString(linkedSettingsPath), dotfilesContents);
        assert.equal(
          yield* fileSystem.readLink(`${baseDir}/userdata/desktop-settings.json`),
          linkedSettingsPath,
        );
        assert.equal(
          yield* fileSystem.readFileString(`${baseDir}/userdata/desktop-window-state.json`),
          '{"mainWindowBounds":{"x":300,"y":40,"width":1200,"height":800},"mainWindowMaximized":false}\n',
        );
        assert.deepEqual(yield* startApp(baseDir), {
          bounds: { x: 300, y: 40, width: 1200, height: 800 },
          maximized: false,
        });
      }),
    ),
  );

  it.effect("falls back to window state stored in desktop-settings.json by older builds", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const legacySettings =
          '{"mainWindowBounds":{"x":120,"y":80,"width":1320,"height":880},"mainWindowMaximized":true,"serverExposureMode":"network-accessible"}\n';
        yield* fileSystem.writeFileString(
          `${baseDir}/userdata/desktop-settings.json`,
          legacySettings,
        );

        assert.deepEqual(yield* startApp(baseDir), {
          bounds: { x: 120, y: 80, width: 1320, height: 880 },
          maximized: true,
        });

        yield* Effect.gen(function* () {
          const windowState = yield* DesktopWindowState.DesktopWindowState;
          yield* (yield* DesktopAppSettings.DesktopAppSettings).load;
          yield* windowState.load;
          yield* windowState.setMainWindowBounds(
            { x: 200, y: 90, width: 1320, height: 880 },
            false,
          );
        }).pipe(Effect.provide(layerWindowState(baseDir)));

        assert.equal(
          yield* fileSystem.readFileString(`${baseDir}/userdata/desktop-settings.json`),
          legacySettings,
        );
        assert.deepEqual(yield* startApp(baseDir), {
          bounds: { x: 200, y: 90, width: 1320, height: 880 },
          maximized: false,
        });
      }),
    ),
  );

  it.effect("prefers desktop-window-state.json over legacy desktop settings", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          `${baseDir}/userdata/desktop-settings.json`,
          '{"mainWindowBounds":{"x":120,"y":80,"width":1320,"height":880},"mainWindowMaximized":true}\n',
        );
        yield* fileSystem.writeFileString(
          `${baseDir}/userdata/desktop-window-state.json`,
          '{"mainWindowBounds":{"x":40,"y":30,"width":900,"height":700}}\n',
        );

        assert.deepEqual(yield* startApp(baseDir), {
          bounds: { x: 40, y: 30, width: 900, height: 700 },
          maximized: false,
        });
      }),
    ),
  );
});
