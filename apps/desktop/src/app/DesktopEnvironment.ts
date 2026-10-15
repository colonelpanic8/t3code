import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import {
  expandT3HomePath,
  selectT3Storage,
  type T3StorageConfigurationError,
  type T3StorageLayout,
  t3StoragePathExists,
  type T3StorageProbeError,
  type T3StorageRoots,
} from "@t3tools/shared/storagePaths";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { resolveLinuxDesktopEntryName } from "./DesktopEarlyElectronStartup.ts";
import { resolveDesktopClientPaths } from "./DesktopStatePaths.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";
import type { OtlpProtocol } from "@t3tools/shared/observability";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
  readonly clientDirSwitch?: string | null;
  readonly temporaryDirectory?: string;
  readonly userId?: number;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly storageLayout: T3StorageLayout;
    readonly storageRoots: T3StorageRoots;
    readonly configDir: string;
    readonly dataDir: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly clientConfigDir: string;
    readonly clientStateDir: string;
    readonly cacheDir: string;
    readonly runtimeDir: string;
    readonly desktopSettingsPath: string;
    readonly desktopWindowStatePath: string;
    readonly clientSettingsPath: string;
    readonly connectionCatalogPath: string;
    readonly savedEnvironmentRegistryPath: string;
    readonly serverSettingsPath: string;
    readonly logDir: string;
    readonly browserArtifactsDir: string;
    readonly electronUserDataPath: string;
    readonly rootDir: string;
    readonly appRoot: string;
    // Root of the tree containing apps/server/dist and node_modules for the
    // backend. Equals appRoot everywhere except packaged Windows, where the
    // server tree ships as the resources/server.asar sidecar (see
    // scripts/build-desktop-artifact.ts) that the asar-aware
    // ELECTRON_RUN_AS_NODE primary reads in place and the WSL backend
    // extracts on demand (see DesktopWslServerTree).
    readonly serverRoot: string;
    readonly backendEntryPath: string;
    // Built web client the packaged renderer is served from over t3code://app.
    readonly clientAssetsDir: string;
    readonly backendCwd: string;
    readonly preloadPath: string;
    // Preload that turns on the V8 compile cache for the local backend.
    readonly compileCachePath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly devRemoteT3ServerEntryPath: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly commitHashOverride: Option.Option<string>;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpMetricsUrl: Option.Option<string>;
    readonly otlpLogsUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly otlpHeaders: Option.Option<Record<string, string>>;
    readonly otlpProtocol: OtlpProtocol;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly linuxDesktopEntryName: string;
    readonly linuxWmClass: string;
    readonly linuxApplicationsDir: string;
    readonly appImagePath: Option.Option<string>;
    readonly defaultDesktopSettings: DesktopAppSettings.DesktopSettings;
    readonly runtimeInfo: DesktopRuntimeInfo;
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
  }
>()("@t3tools/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "T3 Code";

function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<
  DesktopEnvironment["Service"],
  Config.ConfigError | T3StorageConfigurationError | T3StorageProbeError,
  Path.Path
> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () =>
          path.join(homeDirectory, "AppData", "Roaming"),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const pathOperations = {
    join: (...paths: ReadonlyArray<string>) => path.join(...paths),
    resolve: (...paths: ReadonlyArray<string>) => path.resolve(...paths),
    isAbsolute: (candidate: string) => path.isAbsolute(candidate),
  };
  // Synchronous probes: this runs before Electron is ready (see main.ts).
  const selection = selectT3Storage({
    platform: input.platform,
    homeDirectory,
    temporaryDirectory: input.temporaryDirectory ?? NodeOS.tmpdir(),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    isDevelopment,
    environment: config.storageEnvironment,
    path: pathOperations,
    exists: t3StoragePathExists,
  });
  if (selection._tag !== "Selected") return yield* selection.error;
  const storageRoots = selection.roots;
  const { cacheDir, configDir, dataDir, runtimeDir, stateDir } = storageRoots;
  const baseDir = dataDir;
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const serverRoot =
    input.isPackaged && input.platform === "win32"
      ? path.join(input.resourcesPath, "server.asar")
      : appRoot;
  const branding = resolveDesktopAppBranding({
    isDevelopment,
    appVersion: input.appVersion,
  });
  const displayName = branding.displayName;
  const clientPaths = resolveDesktopClientPaths({
    configDir,
    stateDir,
    homeDirectory,
    clientDirSwitch: Option.fromNullishOr(input.clientDirSwitch),
    clientDirEnv: config.clientDir,
    path,
  });
  const linuxApplicationsDir = path.join(
    Option.getOrElse(config.xdgDataHome, () => path.join(homeDirectory, ".local", "share")),
    "applications",
  );
  const resourcesPath = input.resourcesPath;
  const backendCwd = input.isPackaged ? homeDirectory : appRoot;
  // The local backend inherits this env and resolves the override against its cwd.
  const serverConfigDir = Option.match(config.serverConfigDir, {
    onNone: () => configDir,
    onSome: (dir) => path.resolve(backendCwd, expandT3HomePath(dir, homeDirectory, path)),
  });

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath,
    homeDirectory,
    appDataDirectory,
    storageLayout: storageRoots.layout,
    storageRoots,
    configDir,
    dataDir,
    baseDir,
    stateDir,
    cacheDir,
    runtimeDir,
    ...clientPaths,
    serverSettingsPath: path.join(serverConfigDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    // The same directory as the server's, which prunes both by age.
    browserArtifactsDir: path.join(
      storageRoots.layout === "legacy" ? stateDir : dataDir,
      "browser-artifacts",
    ),
    electronUserDataPath: path.join(stateDir, "electron"),
    rootDir,
    appRoot,
    serverRoot,
    backendEntryPath: path.join(serverRoot, "apps/server/dist/bin.mjs"),
    clientAssetsDir: path.join(serverRoot, "apps/server/dist/client"),
    backendCwd,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    compileCachePath: path.join(input.dirname, "compileCache.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpMetricsUrl: config.otlpMetricsUrl,
    otlpLogsUrl: config.otlpLogsUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    otlpHeaders: config.otlpHeaders,
    otlpProtocol: config.otlpProtocol,
    branding,
    displayName,
    appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
      isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
    ),
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment),
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    linuxApplicationsDir,
    appImagePath: config.appImagePath,
    defaultDesktopSettings: DesktopAppSettings.resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
