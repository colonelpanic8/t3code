import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { type DeriveServerPathsOptions, deriveServerPaths } from "./config.ts";
const DEV_URL = new URL("http://localhost:5173");
const derive = (devUrl: URL | undefined, options?: DeriveServerPathsOptions) => deriveServerPaths("/home/t3", devUrl, options).pipe(Effect.provide(NodePath.layerPosix));
const userdataPaths = {
  layout: "legacy",
  configDir: "/home/t3/userdata",
  dataDir: "/home/t3/userdata",
  cacheDir: "/home/t3/caches",
  stateDir: "/home/t3/userdata",
  runtimeDir: "/home/t3/userdata",
  dbPath: "/home/t3/userdata/statev2.sqlite",
  keybindingsConfigPath: "/home/t3/userdata/keybindings.json",
  settingsPath: "/home/t3/userdata/settings.json",
  environmentThemesDir: "/home/t3/userdata/themes",
  providerStatusCacheDir: "/home/t3/caches",
  worktreesDir: "/home/t3/worktrees",
  attachmentsDir: "/home/t3/userdata/attachments",
  browserArtifactsDir: "/home/t3/userdata/browser-artifacts",
  logsDir: "/home/t3/userdata/logs",
  serverTracePath: "/home/t3/userdata/logs/server.trace.ndjson",
  providerLogsDir: "/home/t3/userdata/logs/provider",
  providerEventLogPath: "/home/t3/userdata/logs/provider/events.log",
  terminalLogsDir: "/home/t3/userdata/logs/terminals",
  anonymousIdPath: "/home/t3/userdata/anonymous-id",
  environmentIdPath: "/home/t3/userdata/environment-id",
  serverRuntimeStatePath: "/home/t3/userdata/server-runtime.json",
  secretsDir: "/home/t3/userdata/secrets"
};
const configOverridePaths = {
  configDir: "/etc/t3",
  keybindingsConfigPath: "/etc/t3/keybindings.json",
  settingsPath: "/etc/t3/settings.json",
  environmentThemesDir: "/etc/t3/themes"
};
const dataOverridePaths = {
  dataDir: "/srv/t3",
  stateDir: "/srv/t3",
  runtimeDir: "/srv/t3",
  dbPath: "/srv/t3/statev2.sqlite",
  worktreesDir: "/srv/t3/worktrees",
  attachmentsDir: "/srv/t3/attachments",
  browserArtifactsDir: "/srv/t3/browser-artifacts",
  logsDir: "/srv/t3/logs",
  serverTracePath: "/srv/t3/logs/server.trace.ndjson",
  providerLogsDir: "/srv/t3/logs/provider",
  providerEventLogPath: "/srv/t3/logs/provider/events.log",
  terminalLogsDir: "/srv/t3/logs/terminals",
  anonymousIdPath: "/srv/t3/anonymous-id",
  environmentIdPath: "/srv/t3/environment-id",
  serverRuntimeStatePath: "/srv/t3/server-runtime.json",
  secretsDir: "/srv/t3/secrets"
};
const cacheOverridePaths = {
  cacheDir: "/var/cache/t3",
  providerStatusCacheDir: "/var/cache/t3"
};
describe("deriveServerPaths", () => {
  it.effect("keeps today's layout without overrides", () => Effect.gen(function* () {
    expect(yield* derive(undefined)).toEqual(userdataPaths);
    expect(yield* derive(undefined, {
      baseDirIsExplicit: true
    })).toEqual(userdataPaths);
  }));
  it.effect("isolates an implicit dev root and lets an explicit base dir opt out", () => Effect.gen(function* () {
    expect(yield* derive(DEV_URL)).toEqual({
      layout: "legacy",
      configDir: "/home/t3/dev",
      dataDir: "/home/t3/dev",
      cacheDir: "/home/t3/caches",
      stateDir: "/home/t3/dev",
      runtimeDir: "/home/t3/dev",
      dbPath: "/home/t3/dev/statev2.sqlite",
      keybindingsConfigPath: "/home/t3/dev/keybindings.json",
      settingsPath: "/home/t3/dev/settings.json",
      environmentThemesDir: "/home/t3/dev/themes",
      providerStatusCacheDir: "/home/t3/caches",
      worktreesDir: "/home/t3/worktrees",
      attachmentsDir: "/home/t3/dev/attachments",
      browserArtifactsDir: "/home/t3/dev/browser-artifacts",
      logsDir: "/home/t3/dev/logs",
      serverTracePath: "/home/t3/dev/logs/server.trace.ndjson",
      providerLogsDir: "/home/t3/dev/logs/provider",
      providerEventLogPath: "/home/t3/dev/logs/provider/events.log",
      terminalLogsDir: "/home/t3/dev/logs/terminals",
      anonymousIdPath: "/home/t3/dev/anonymous-id",
      environmentIdPath: "/home/t3/dev/environment-id",
      serverRuntimeStatePath: "/home/t3/dev/server-runtime.json",
      secretsDir: "/home/t3/dev/secrets"
    });
    expect(yield* derive(DEV_URL, {
      baseDirIsExplicit: true
    })).toEqual(userdataPaths);
  }));
  it.effect("moves only the config files with a config dir", () => Effect.gen(function* () {
    expect(yield* derive(undefined, {
      configDir: "/etc/t3"
    })).toEqual({
      ...userdataPaths,
      ...configOverridePaths
    });
  }));
  it.effect("moves data and worktrees with a data dir", () => Effect.gen(function* () {
    expect(yield* derive(undefined, {
      dataDir: "/srv/t3"
    })).toEqual({
      ...userdataPaths,
      ...dataOverridePaths
    });
  }));
  it.effect("moves only the provider status cache with a cache dir", () => Effect.gen(function* () {
    expect(yield* derive(undefined, {
      cacheDir: "/var/cache/t3"
    })).toEqual({
      ...userdataPaths,
      ...cacheOverridePaths
    });
  }));
  it.effect("applies all three overrides independently of the base dir and dev root", () => Effect.gen(function* () {
    const overrides = {
      configDir: "/etc/t3",
      dataDir: "/srv/t3",
      cacheDir: "/var/cache/t3"
    };
    const expected = {
      ...userdataPaths,
      ...configOverridePaths,
      ...dataOverridePaths,
      ...cacheOverridePaths
    };
    expect(yield* derive(undefined, overrides)).toEqual(expected);
    expect(yield* derive(undefined, {
      baseDirIsExplicit: true,
      ...overrides
    })).toEqual(expected);
    expect(yield* derive(DEV_URL, overrides)).toEqual(expected);
  }));
  it.effect("keeps the implicit dev root for categories without an override", () => Effect.gen(function* () {
    const paths = yield* derive(DEV_URL, {
      dataDir: "/srv/t3"
    });
    expect(paths.settingsPath).toBe("/home/t3/dev/settings.json");
    expect(paths.environmentThemesDir).toBe("/home/t3/dev/themes");
    expect(paths.providerStatusCacheDir).toBe("/home/t3/caches");
    expect(paths.dbPath).toBe("/srv/t3/statev2.sqlite");
    expect(paths.worktreesDir).toBe("/srv/t3/worktrees");
  }));
  it.effect("puts each file under its split root", () => Effect.gen(function* () {
    expect(yield* derive(DEV_URL, {
      configDir: "/xdg/config/t3code",
      dataDir: "/xdg/data/t3code",
      cacheDir: "/xdg/cache/t3code",
      split: {
        stateDir: "/xdg/state/t3code",
        runtimeDir: "/run/user/1000/t3code"
      }
    })).toEqual({
      layout: "split",
      configDir: "/xdg/config/t3code",
      dataDir: "/xdg/data/t3code",
      cacheDir: "/xdg/cache/t3code",
      stateDir: "/xdg/state/t3code",
      runtimeDir: "/run/user/1000/t3code",
      dbPath: "/xdg/state/t3code/statev2.sqlite",
      keybindingsConfigPath: "/xdg/config/t3code/keybindings.json",
      settingsPath: "/xdg/config/t3code/settings.json",
      environmentThemesDir: "/xdg/config/t3code/themes",
      providerStatusCacheDir: "/xdg/cache/t3code/provider-status",
      worktreesDir: "/xdg/data/t3code/worktrees",
      attachmentsDir: "/xdg/data/t3code/attachments",
      browserArtifactsDir: "/xdg/data/t3code/browser-artifacts",
      logsDir: "/xdg/state/t3code/logs",
      serverTracePath: "/xdg/state/t3code/logs/server.trace.ndjson",
      providerLogsDir: "/xdg/state/t3code/logs/provider",
      providerEventLogPath: "/xdg/state/t3code/logs/provider/events.log",
      terminalLogsDir: "/xdg/state/t3code/logs/terminals",
      anonymousIdPath: "/xdg/state/t3code/anonymous-id",
      environmentIdPath: "/xdg/state/t3code/environment-id",
      serverRuntimeStatePath: "/run/user/1000/t3code/server-runtime.json",
      secretsDir: "/xdg/state/t3code/secrets"
    });
  }));
});
