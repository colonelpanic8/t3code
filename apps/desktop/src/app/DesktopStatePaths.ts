import { resolveT3ConfiguredPath, type StoragePathOperations } from "@t3tools/shared/storagePaths";
import * as Option from "effect/Option";

export interface DesktopClientPaths {
  readonly clientConfigDir: string;
  readonly clientStateDir: string;
  readonly desktopSettingsPath: string;
  readonly clientSettingsPath: string;
  readonly desktopWindowStatePath: string;
  readonly connectionCatalogPath: string;
  readonly savedEnvironmentRegistryPath: string;
}

/**
 * The desktop app's own files, shared by the pre-ready password-store read and
 * DesktopEnvironment. `--client-dir` beats T3CODE_CLIENT_DIR and holds everything;
 * otherwise settings use the client config root and state the client state root.
 * Shells leave `~` unexpanded after `=` and in .desktop Exec lines, so it is expanded here.
 */
export function resolveDesktopClientPaths(input: {
  readonly configDir: string;
  readonly stateDir: string;
  readonly homeDirectory: string;
  readonly clientDirSwitch: Option.Option<string>;
  readonly clientDirEnv: Option.Option<string>;
  readonly path: Pick<StoragePathOperations, "join" | "resolve">;
}): DesktopClientPaths {
  const clientDir =
    resolveT3ConfiguredPath(
      Option.getOrUndefined(input.clientDirSwitch),
      input.homeDirectory,
      input.path,
    ) ??
    resolveT3ConfiguredPath(
      Option.getOrUndefined(input.clientDirEnv),
      input.homeDirectory,
      input.path,
    );
  const clientConfigDir = clientDir ?? input.configDir;
  const clientStateDir = clientDir ?? input.stateDir;
  const { join } = input.path;
  return {
    clientConfigDir,
    clientStateDir,
    desktopSettingsPath: join(clientConfigDir, "desktop-settings.json"),
    clientSettingsPath: join(clientConfigDir, "client-settings.json"),
    desktopWindowStatePath: join(clientStateDir, "desktop-window-state.json"),
    connectionCatalogPath: join(clientStateDir, "connection-catalog.json"),
    savedEnvironmentRegistryPath: join(clientStateDir, "saved-environments.json"),
  };
}

export interface DesktopClientPaths {
  readonly clientConfigDir: string;
  readonly clientStateDir: string;
  readonly desktopSettingsPath: string;
  readonly clientSettingsPath: string;
  readonly desktopWindowStatePath: string;
  readonly connectionCatalogPath: string;
  readonly savedEnvironmentRegistryPath: string;
}

// Shells leave `~` unexpanded after `=` and in .desktop Exec lines, so expand
// it here, matching the server's location overrides.
function expandHomeDir(dir: string, homeDirectory: string, joinPath: JoinPath): string {
  if (dir === "~") {
    return homeDirectory;
  }
  if (dir.startsWith("~/") || dir.startsWith("~\\")) {
    return joinPath(homeDirectory, dir.slice(2));
  }
  return dir;
}

// Shared by the pre-ready password-store read and DesktopEnvironment so both
// see the same desktop-settings.json. `--client-dir` wins over
// T3CODE_CLIENT_DIR; with neither, client files stay in the server's stateDir.
export function resolveDesktopClientPaths(input: {
  readonly stateDir: string;
  readonly homeDirectory: string;
  readonly clientDirSwitch: Option.Option<string>;
  readonly clientDirEnv: Option.Option<string>;
  readonly joinPath: JoinPath;
  readonly resolvePath: ResolvePath;
}): DesktopClientPaths {
  const clientDir = normalizeConfiguredDir(input.clientDirSwitch).pipe(
    Option.orElse(() => normalizeConfiguredDir(input.clientDirEnv)),
    Option.map((dir) => input.resolvePath(expandHomeDir(dir, input.homeDirectory, input.joinPath))),
    Option.getOrElse(() => input.stateDir),
  );
  const clientConfigDir = clientDir;
  const clientStateDir = clientDir;
  return {
    clientConfigDir,
    clientStateDir,
    desktopSettingsPath: input.joinPath(clientConfigDir, "desktop-settings.json"),
    clientSettingsPath: input.joinPath(clientConfigDir, "client-settings.json"),
    desktopWindowStatePath: input.joinPath(clientStateDir, "desktop-window-state.json"),
    connectionCatalogPath: input.joinPath(clientStateDir, "connection-catalog.json"),
    savedEnvironmentRegistryPath: input.joinPath(clientStateDir, "saved-environments.json"),
  };
}
