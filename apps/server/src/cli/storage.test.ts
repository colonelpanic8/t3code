import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveMigrationInput } from "./storage.ts";

const noFlags = {
  baseDir: Option.none<string>(),
  clientDir: Option.none<string>(),
  serverConfigDir: Option.none<string>(),
  serverDataDir: Option.none<string>(),
  serverConfigFile: Option.none<string>(),
};

const inputFor = (platform: NodeJS.Platform, env: Record<string, string>) =>
  resolveMigrationInput(noFlags).pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.HomeDirectory, "/home/alice"),
    Effect.provide(
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NodeServices.layer),
    ),
  );

// Each expectation is the path DesktopEnvironment and DesktopUserData give the
// desktop on that platform, so the migration writes where the desktop reads.
describe("t3 storage migrate locations", () => {
  it.effect("follows the desktop's profiles and client roots on Linux", () =>
    Effect.gen(function* () {
      const input = yield* inputFor("linux", {
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_STATE_HOME: "/xdg/state",
      });
      assert.equal(input.legacyRoots.stateDir, "/home/alice/.t3/userdata");
      assert.equal(input.legacyElectronProfile, "/xdg/config/t3code-v2");
      assert.equal(input.electronProfile, "/xdg/state/t3code-client/electron");
      assert.equal(input.clientRoots.configDir, "/xdg/config/t3code-client");
      assert.equal(input.serviceUnitPath, "/home/alice/.config/systemd/user/t3code.service");
    }),
  );

  it.effect("ignores XDG variables on macOS, as the desktop does", () =>
    Effect.gen(function* () {
      const input = yield* inputFor("darwin", { XDG_STATE_HOME: "/xdg/state" });
      assert.equal(
        input.legacyElectronProfile,
        "/home/alice/Library/Application Support/t3code-v2",
      );
      assert.equal(
        input.electronProfile,
        "/home/alice/Library/Application Support/t3code-client/state/electron",
      );
    }),
  );

  it.effect("uses APPDATA and LOCALAPPDATA on Windows", () =>
    Effect.gen(function* () {
      const input = yield* inputFor("win32", {
        APPDATA: " /roaming ",
        LOCALAPPDATA: "/local",
      });
      assert.equal(input.legacyElectronProfile, "/roaming/t3code-v2");
      assert.equal(input.electronProfile, "/local/t3code-client/state/electron");
      assert.isUndefined(input.serviceUnitPath);
    }),
  );

  it.effect("names the legacy tree from T3CODE_HOME and the client dir from its variable", () =>
    Effect.gen(function* () {
      const input = yield* inputFor("linux", {
        T3CODE_HOME: "~/old-t3",
        T3CODE_CLIENT_DIR: "~/client",
      });
      assert.equal(input.legacyRoots.stateDir, "/home/alice/old-t3/userdata");
      assert.equal(input.clientDir, "/home/alice/client");
    }),
  );
});
