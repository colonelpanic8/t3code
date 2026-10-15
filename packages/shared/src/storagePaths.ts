// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

export const T3CODE_CONFIG_DIR_ENV = "T3CODE_CONFIG_DIR";
export const T3CODE_DATA_DIR_ENV = "T3CODE_DATA_DIR";
export const T3CODE_STATE_DIR_ENV = "T3CODE_STATE_DIR";
export const T3CODE_CACHE_DIR_ENV = "T3CODE_CACHE_DIR";
export const T3CODE_RUNTIME_DIR_ENV = "T3CODE_RUNTIME_DIR";

/** The split layout's root selectors. */
export const T3_STORAGE_SELECTOR_ENVIRONMENT_NAMES = [
  T3CODE_CONFIG_DIR_ENV,
  T3CODE_DATA_DIR_ENV,
  T3CODE_STATE_DIR_ENV,
  T3CODE_CACHE_DIR_ENV,
  T3CODE_RUNTIME_DIR_ENV,
] as const;

/** Every variable that selects server storage, legacy home first. */
export const T3_STORAGE_ENVIRONMENT_NAMES = [
  "T3CODE_HOME",
  ...T3_STORAGE_SELECTOR_ENVIRONMENT_NAMES,
] as const;

/** Per-category server location overrides, which apply on top of either layout. */
export const T3_SERVER_LOCATION_ENVIRONMENT_NAMES = [
  "T3CODE_SERVER_CONFIG_DIR",
  "T3CODE_SERVER_DATA_DIR",
  "T3CODE_SERVER_CACHE_DIR",
  "T3CODE_SERVER_CONFIG_FILE",
] as const;

export type T3StorageLayout = "split" | "legacy";
export type T3ForcedStorageLayout = "xdg" | "legacy";

interface T3StorageDirectories {
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly runtimeDir: string;
}

export interface T3SplitStorageRoots extends T3StorageDirectories {
  readonly layout: "split";
}

export interface T3LegacyStorageRoots extends T3StorageDirectories {
  readonly layout: "legacy";
  readonly legacyBaseDir: string;
}

export type T3StorageRoots = T3SplitStorageRoots | T3LegacyStorageRoots;

export interface T3StorageDirectoryOverrides {
  readonly configDir?: string;
  readonly dataDir?: string;
  readonly stateDir?: string;
  readonly cacheDir?: string;
  readonly runtimeDir?: string;
}

export interface StoragePathOperations {
  readonly join: (...paths: ReadonlyArray<string>) => string;
  readonly resolve: (...paths: ReadonlyArray<string>) => string;
  readonly isAbsolute: (path: string) => boolean;
}

export interface ResolveDefaultT3StorageRootsInput {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
  readonly userId?: number;
  readonly isDevelopment: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly path: StoragePathOperations;
}

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
};

const absoluteEnvironmentDirectory = (
  value: string | undefined,
  path: StoragePathOperations,
): string | undefined => {
  const candidate = trimmed(value);
  return candidate !== undefined && path.isAbsolute(candidate) ? candidate : undefined;
};

/** Expands a leading `~` to `homeDirectory`. */
export const expandT3HomePath = (
  value: string,
  homeDirectory: string,
  path: Pick<StoragePathOperations, "join">,
): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

/** A configured directory: trimmed, `~` expanded, and resolved; blank is unset. */
export const resolveT3ConfiguredPath = (
  value: string | undefined,
  homeDirectory: string,
  path: Pick<StoragePathOperations, "join" | "resolve">,
): string | undefined => {
  const candidate = trimmed(value);
  return candidate === undefined
    ? undefined
    : path.resolve(expandT3HomePath(candidate, homeDirectory, path));
};

export function hasT3StorageDirectoryOverrides(overrides: T3StorageDirectoryOverrides): boolean {
  return Object.values(overrides).some((value) => value !== undefined);
}

export function resolveT3StorageDirectoryOverrides(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly path: StoragePathOperations;
}): T3StorageDirectoryOverrides {
  const { environment, homeDirectory, path } = input;
  const resolve = (name: string) => resolveT3ConfiguredPath(environment[name], homeDirectory, path);
  const configDir = resolve(T3CODE_CONFIG_DIR_ENV);
  const dataDir = resolve(T3CODE_DATA_DIR_ENV);
  const stateDir = resolve(T3CODE_STATE_DIR_ENV);
  const cacheDir = resolve(T3CODE_CACHE_DIR_ENV);
  const runtimeDir = resolve(T3CODE_RUNTIME_DIR_ENV);
  return {
    ...(configDir === undefined ? {} : { configDir }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
  };
}

export function resolveDefaultT3StorageRoots(
  input: ResolveDefaultT3StorageRootsInput,
): T3SplitStorageRoots {
  const { environment, homeDirectory, isDevelopment, path, platform, temporaryDirectory } = input;
  const applicationDirectoryName = isDevelopment ? "t3code-dev" : "t3code";
  const runtimeFallbackName =
    input.userId === undefined
      ? applicationDirectoryName
      : `${applicationDirectoryName}-${String(input.userId)}`;

  if (platform === "win32") {
    const roamingApplicationData =
      trimmed(environment.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
    const localApplicationData =
      trimmed(environment.LOCALAPPDATA) ?? path.join(homeDirectory, "AppData", "Local");
    const localRoot = path.join(localApplicationData, applicationDirectoryName);
    return {
      layout: "split",
      configDir: path.join(roamingApplicationData, applicationDirectoryName),
      dataDir: path.join(localRoot, "data"),
      stateDir: path.join(localRoot, "state"),
      cacheDir: path.join(localRoot, "cache"),
      runtimeDir: path.join(localRoot, "runtime"),
    };
  }

  // A Finder-launched app never sees a shell's XDG variables, so honoring them
  // here would put the desktop and a terminal CLI in different directories.
  if (platform === "darwin") {
    const applicationSupportRoot = path.join(
      homeDirectory,
      "Library",
      "Application Support",
      applicationDirectoryName,
    );
    return {
      layout: "split",
      configDir: path.join(applicationSupportRoot, "config"),
      dataDir: path.join(applicationSupportRoot, "data"),
      stateDir: path.join(applicationSupportRoot, "state"),
      cacheDir: path.join(homeDirectory, "Library", "Caches", applicationDirectoryName),
      runtimeDir: path.join(temporaryDirectory, runtimeFallbackName),
    };
  }

  const xdgRuntimeHome = absoluteEnvironmentDirectory(environment.XDG_RUNTIME_DIR, path);
  const xdgRoot = (name: string, fallback: ReadonlyArray<string>) =>
    path.join(
      absoluteEnvironmentDirectory(environment[name], path) ??
        path.join(homeDirectory, ...fallback),
      applicationDirectoryName,
    );
  return {
    layout: "split",
    configDir: xdgRoot("XDG_CONFIG_HOME", [".config"]),
    dataDir: xdgRoot("XDG_DATA_HOME", [".local", "share"]),
    stateDir: xdgRoot("XDG_STATE_HOME", [".local", "state"]),
    cacheDir: xdgRoot("XDG_CACHE_HOME", [".cache"]),
    runtimeDir:
      xdgRuntimeHome === undefined
        ? path.join(temporaryDirectory, runtimeFallbackName)
        : path.join(xdgRuntimeHome, applicationDirectoryName),
  };
}

export function applyT3StorageDirectoryOverrides(
  defaults: T3SplitStorageRoots,
  overrides: T3StorageDirectoryOverrides,
): T3SplitStorageRoots {
  return {
    layout: "split",
    configDir: overrides.configDir ?? defaults.configDir,
    dataDir: overrides.dataDir ?? defaults.dataDir,
    stateDir: overrides.stateDir ?? defaults.stateDir,
    cacheDir: overrides.cacheDir ?? defaults.cacheDir,
    runtimeDir: overrides.runtimeDir ?? defaults.runtimeDir,
  };
}

export function resolveLegacyT3StorageRoots(input: {
  readonly baseDir: string;
  readonly stateDirectoryName: "userdata" | "dev";
  readonly path: Pick<StoragePathOperations, "join">;
}): T3LegacyStorageRoots {
  const stateDir = input.path.join(input.baseDir, input.stateDirectoryName);
  return {
    layout: "legacy",
    configDir: stateDir,
    dataDir: input.baseDir,
    stateDir,
    cacheDir: input.path.join(input.baseDir, "caches"),
    runtimeDir: stateDir,
    legacyBaseDir: input.baseDir,
  };
}

/** Files whose presence marks the legacy tree as an initialized installation. */
export function legacyT3StorageArtifactPaths(
  roots: T3StorageRoots,
  path: Pick<StoragePathOperations, "join">,
): ReadonlyArray<string> {
  return [
    path.join(roots.stateDir, "state.sqlite"),
    path.join(roots.stateDir, "statev2.sqlite"),
    path.join(roots.configDir, "settings.json"),
    path.join(roots.configDir, "keybindings.json"),
    path.join(roots.configDir, "desktop-settings.json"),
    path.join(roots.configDir, "client-settings.json"),
    path.join(roots.stateDir, "environment-id"),
    path.join(roots.stateDir, "connection-catalog.json"),
    path.join(roots.stateDir, "secrets"),
    path.join(roots.stateDir, "saved-environments.json"),
  ];
}

/** Files whose presence marks the split layout as holding a server's state. */
export function splitT3StorageArtifactPaths(
  roots: T3StorageRoots,
  path: Pick<StoragePathOperations, "join">,
): ReadonlyArray<string> {
  return [
    path.join(roots.stateDir, "statev2.sqlite"),
    path.join(roots.stateDir, "environment-id"),
    path.join(roots.stateDir, "secrets"),
  ];
}

/** `existsSync` that throws instead of answering when the answer is unknown. */
export function t3StoragePathExists(path: string): boolean {
  try {
    NodeFS.statSync(path);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw cause;
  }
}

export type T3StorageConflict = "home-with-selectors" | "xdg-with-home";

const SELECTOR_LIST =
  "T3CODE_CONFIG_DIR, T3CODE_DATA_DIR, T3CODE_STATE_DIR, T3CODE_CACHE_DIR, or T3CODE_RUNTIME_DIR";

export class T3StorageConfigurationError extends Schema.TaggedError<T3StorageConfigurationError>()(
  "T3StorageConfigurationError",
  { conflict: Schema.Literals(["home-with-selectors", "xdg-with-home"]) },
) {
  override get message(): string {
    switch (this.conflict) {
      case "home-with-selectors":
        return `T3CODE_HOME/--base-dir cannot be combined with ${SELECTOR_LIST}.`;
      case "xdg-with-home":
        return "--storage-layout xdg cannot be combined with --base-dir.";
    }
  }
}

export class T3StorageProbeError extends Schema.TaggedError<T3StorageProbeError>()(
  "T3StorageProbeError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not check whether '${this.path}' exists, so T3 Code cannot tell which storage layout holds its data.`;
  }
}

export interface SelectT3StorageInput extends ResolveDefaultT3StorageRootsInput {
  /** A --base-dir flag, which outranks T3CODE_HOME. */
  readonly baseDir?: string | undefined;
  readonly forcedLayout?: T3ForcedStorageLayout | undefined;
  /** Roots a launching process already selected; only an explicit home outranks them. */
  readonly pinned?: T3StorageRoots | undefined;
  /** Whether a path exists. Throws when that cannot be determined. */
  readonly exists: (path: string) => boolean;
}

export interface T3StorageSelected {
  readonly _tag: "Selected";
  readonly roots: T3StorageRoots;
  /** Legacy only: a named home keeps `userdata` even in development. */
  readonly baseDirIsExplicit: boolean;
  /** An initialized legacy state dir the selected split layout leaves unused. */
  readonly shadowedLegacyStateDir?: string;
}

export type T3StorageSelection =
  | T3StorageSelected
  | { readonly _tag: "Conflict"; readonly error: T3StorageConfigurationError }
  | { readonly _tag: "ProbeFailed"; readonly error: T3StorageProbeError };

/**
 * The storage a T3 process uses: --base-dir, then a forced layout, then
 * T3CODE_HOME, then pinned roots, then the T3CODE_*_DIR selectors, then
 * whichever of the split layout and ~/.t3 already holds an installation (split
 * first), and finally the platform's split defaults.
 */
export function selectT3Storage(input: SelectT3StorageInput): T3StorageSelection {
  const { environment, homeDirectory, path } = input;
  const flagHome = resolveT3ConfiguredPath(input.baseDir, homeDirectory, path);
  const environmentHome = resolveT3ConfiguredPath(environment.T3CODE_HOME, homeDirectory, path);
  const selectors = resolveT3StorageDirectoryOverrides({ environment, homeDirectory, path });
  const hasSelectors = hasT3StorageDirectoryOverrides(selectors);
  const conflict = (value: T3StorageConflict): T3StorageSelection => ({
    _tag: "Conflict",
    error: new T3StorageConfigurationError({ conflict: value }),
  });
  const selected = (roots: T3StorageRoots, baseDirIsExplicit = false): T3StorageSelected => ({
    _tag: "Selected",
    roots,
    baseDirIsExplicit,
  });
  const explicitLegacy = (baseDir: string) =>
    selected(resolveLegacyT3StorageRoots({ baseDir, stateDirectoryName: "userdata", path }), true);
  const splitRoots = () =>
    applyT3StorageDirectoryOverrides(resolveDefaultT3StorageRoots(input), selectors);
  const defaultLegacyRoots = resolveLegacyT3StorageRoots({
    baseDir: path.join(homeDirectory, ".t3"),
    stateDirectoryName: input.isDevelopment ? "dev" : "userdata",
    path,
  });

  // Command-line controls outrank inherited variables, as a split service
  // exports the selectors into every shell it starts.
  if (flagHome !== undefined) {
    return input.forcedLayout === "xdg" ? conflict("xdg-with-home") : explicitLegacy(flagHome);
  }
  if (input.forcedLayout === "xdg") return selected(splitRoots());
  if (input.forcedLayout === "legacy") {
    return environmentHome === undefined
      ? selected(defaultLegacyRoots)
      : explicitLegacy(environmentHome);
  }
  // Two variables naming different layouts have no winner.
  if (environmentHome !== undefined) {
    return hasSelectors ? conflict("home-with-selectors") : explicitLegacy(environmentHome);
  }
  if (input.pinned !== undefined) return selected(input.pinned);
  if (hasSelectors) return selected(splitRoots());

  const legacyRoots = defaultLegacyRoots;
  const split = splitRoots();
  let probing = "";
  try {
    const initialized = (paths: ReadonlyArray<string>) =>
      paths.some((candidate) => {
        probing = candidate;
        return input.exists(candidate);
      });
    const splitInitialized = initialized(splitT3StorageArtifactPaths(split, path));
    const legacyInitialized = initialized(legacyT3StorageArtifactPaths(legacyRoots, path));
    if (splitInitialized) {
      return legacyInitialized
        ? { ...selected(split), shadowedLegacyStateDir: legacyRoots.stateDir }
        : selected(split);
    }
    return selected(legacyInitialized ? legacyRoots : split);
  } catch (cause) {
    return { _tag: "ProbeFailed", error: new T3StorageProbeError({ path: probing, cause }) };
  }
}

/**
 * The variables that pin `roots` for a child process. `includeRuntimeDir`
 * false leaves the runtime dir to the child's own XDG_RUNTIME_DIR.
 */
export function t3StorageEnvironment(
  roots: T3StorageRoots,
  options: { readonly includeRuntimeDir?: boolean } = {},
): Readonly<Record<string, string>> {
  if (roots.layout === "legacy") return { T3CODE_HOME: roots.legacyBaseDir };
  return {
    [T3CODE_CONFIG_DIR_ENV]: roots.configDir,
    [T3CODE_DATA_DIR_ENV]: roots.dataDir,
    [T3CODE_STATE_DIR_ENV]: roots.stateDir,
    [T3CODE_CACHE_DIR_ENV]: roots.cacheDir,
    ...(options.includeRuntimeDir === false ? {} : { [T3CODE_RUNTIME_DIR_ENV]: roots.runtimeDir }),
  };
}
