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
 * Where the desktop app keeps its own files. Shared by the pre-ready
 * password-store read and DesktopEnvironment so both see the same
 * desktop-settings.json. `--client-dir` wins over T3CODE_CLIENT_DIR and holds
 * all of these files; with neither, settings go in the client config root and
 * state in the client state root (both `userdata` in the legacy tree). Shells
 * leave `~` unexpanded after `=` and in .desktop Exec lines, so it is expanded
 * here.
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
