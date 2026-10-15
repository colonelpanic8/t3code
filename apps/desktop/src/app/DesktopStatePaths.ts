import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;
export type ResolvePath = (...segments: string[]) => string;

function normalizeConfiguredDir(dir: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(dir)) {
    return Option.none();
  }
  const trimmed = dir.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".t3"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir = input.isDevelopment && Option.isNone(normalizeConfiguredDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
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
