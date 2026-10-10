// @effect-diagnostics nodeBuiltinImport:off
import * as NetService from "@t3tools/shared/Net";
import {
  OtlpHeadersFromString,
  OtlpProtocol,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as NodeOS from "node:os";
import {
  applyT3StorageDirectoryOverrides,
  hasT3StorageDirectoryOverrides,
  legacyT3StorageArtifactPaths,
  legacyT3StorageMigrationMarkerPath,
  resolveDefaultT3StorageRoots,
  resolveLegacyT3StorageRoots,
  resolveT3ClientStorageRoots,
  resolveT3StorageDirectoryOverrides,
  selectT3StorageRoots,
  type T3StorageRoots,
} from "@t3tools/shared/storagePaths";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import {
  isProcessAlive,
  isRespondingServerRuntime,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";

const modeFlag = Flag.Literals("mode", ServerConfig.RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.Int("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription(
    "Use the legacy unified T3 Code directory layout; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
  ),
  Flag.optional,
);
export const CliStorageLayout = Schema.Literals(["xdg", "legacy"]);
export type CliStorageLayout = typeof CliStorageLayout.Type;
const storageLayoutFlag = Flag.Literals("storage-layout", CliStorageLayout.literals).pipe(
  Flag.withDescription(
    "Force the XDG/platform-native split layout or the legacy unified layout instead of selecting automatically.",
  ),
  Flag.optional,
);
const devUrlFlag = Flag.String("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.Boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.Int("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.Boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const tailscaleServeFlag = Flag.Boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
const tailscaleServePortFlag = Flag.Int("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);

// Trace file location, shared by the server and `t3 trace summary`.
export const traceFileConfig = Config.String("T3CODE_TRACE_FILE").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);
export const traceMaxFilesConfig = Config.Int("T3CODE_TRACE_MAX_FILES").pipe(
  Config.withDefault(10),
);

const EnvStorageConfig = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3ConfigDir: Config.String("T3CODE_CONFIG_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3DataDir: Config.String("T3CODE_DATA_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3StateDir: Config.String("T3CODE_STATE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3CacheDir: Config.String("T3CODE_CACHE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3RuntimeDir: Config.String("T3CODE_RUNTIME_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3ClientConfigDir: Config.String("T3CODE_CLIENT_CONFIG_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3ClientStateDir: Config.String("T3CODE_CLIENT_STATE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  t3ClientCacheDir: Config.String("T3CODE_CLIENT_CACHE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  xdgConfigHome: Config.String("XDG_CONFIG_HOME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  xdgDataHome: Config.String("XDG_DATA_HOME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  xdgStateHome: Config.String("XDG_STATE_HOME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  xdgCacheHome: Config.String("XDG_CACHE_HOME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  xdgRuntimeDir: Config.String("XDG_RUNTIME_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  appData: Config.String("APPDATA").pipe(Config.option, Config.map(Option.getOrUndefined)),
  localAppData: Config.String("LOCALAPPDATA").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const EnvServerConfig = Config.all({
  logLevel: Config.LogLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.LogLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.Boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: traceFileConfig,
  traceMaxBytes: Config.Int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: traceMaxFilesConfig,
  traceBatchWindowMs: Config.Int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(1_000)),
  otlpTracesUrl: Config.String("T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.String("T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpLogsUrl: Config.String("T3CODE_OTLP_LOGS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  mode: Config.schema(ServerConfig.RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.Port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.String("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  managedAccessToken: Config.String("T3CODE_MANAGED_ACCESS_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  environmentIdOverride: Config.String("T3CODE_ENVIRONMENT_ID").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  managedSettingsFile: Config.String("T3CODE_MANAGED_SETTINGS_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  managedKeybindingsFile: Config.String("T3CODE_MANAGED_KEYBINDINGS_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devAllowedOrigins: Config.String("T3CODE_DEV_ALLOWED_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ),
  noBrowser: Config.Boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.Int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.Boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.Boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServeEnabled: Config.Boolean("T3CODE_TAILSCALE_SERVE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServePort: Config.Port("T3CODE_TAILSCALE_SERVE_PORT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const DevAuthTokenConfig = Config.Redacted("T3CODE_DEV_AUTH_TOKEN").pipe(
  Config.map((token) => Redacted.make(Redacted.value(token).trim())),
  Config.mapEffect((token) =>
    Redacted.value(token).length === 0 || Redacted.value(token).length >= 32
      ? Effect.succeed(token)
      : Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: "T3CODE_DEV_AUTH_TOKEN must contain at least 32 characters.",
              }),
            ),
          ),
        ),
  ),
  Config.option,
  Config.map(Option.filter((token) => Redacted.value(token).length > 0)),
  Config.map(Option.getOrUndefined),
);

export interface CliServerFlags {
  readonly mode: Option.Option<ServerConfig.RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly storageLayout?: Option.Option<CliStorageLayout>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly storageLayout?: Option.Option<CliStorageLayout>;
  readonly devUrl?: Option.Option<URL>;
}

export const authLocationFlags = {
  baseDir: baseDirFlag,
  storageLayout: storageLayoutFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
  storageLayout: storageLayoutFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  storageLayout: storageLayoutFlag,
  cwd: Argument.String("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
} as const;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export class StorageDirectoryConfigurationConflictError extends Schema.TaggedError<StorageDirectoryConfigurationConflictError>()(
  "StorageDirectoryConfigurationConflictError",
  {},
) {
  override get message(): string {
    return "T3CODE_HOME/--base-dir cannot be combined with T3CODE_CONFIG_DIR, T3CODE_DATA_DIR, T3CODE_STATE_DIR, T3CODE_CACHE_DIR, or T3CODE_RUNTIME_DIR.";
  }
}

export class ForcedXdgLayoutConflictError extends Schema.TaggedError<ForcedXdgLayoutConflictError>()(
  "ForcedXdgLayoutConflictError",
  {},
) {
  override get message(): string {
    return "--storage-layout xdg cannot be combined with T3CODE_HOME or --base-dir.";
  }
}

export class ForcedLegacyLayoutConflictError extends Schema.TaggedError<ForcedLegacyLayoutConflictError>()(
  "ForcedLegacyLayoutConflictError",
  {},
) {
  override get message(): string {
    return "--storage-layout legacy cannot be combined with T3CODE_CONFIG_DIR, T3CODE_DATA_DIR, T3CODE_STATE_DIR, T3CODE_CACHE_DIR, or T3CODE_RUNTIME_DIR.";
  }
}

export class LegacyStorageMigratedError extends Schema.TaggedError<LegacyStorageMigratedError>()(
  "LegacyStorageMigratedError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `The legacy storage at '${this.stateDir}' was copied to the split layout by \`t3 storage migrate\`. Unset T3CODE_HOME and drop --base-dir or --storage-layout legacy to use the copy, or run \`t3 storage migrate --rollback\` to return to the legacy tree.`;
  }
}

export class RuntimeDirectoryOpenError extends Schema.TaggedError<RuntimeDirectoryOpenError>()(
  "RuntimeDirectoryOpenError",
  {
    runtimeDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Refusing to use runtime directory '${this.runtimeDir}' because it could not be opened without following symbolic links.`;
  }
}

export class RuntimeDirectoryNotADirectoryError extends Schema.TaggedError<RuntimeDirectoryNotADirectoryError>()(
  "RuntimeDirectoryNotADirectoryError",
  {
    runtimeDir: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to use runtime directory '${this.runtimeDir}' because it is not a directory.`;
  }
}

export class RuntimeDirectoryOwnerMismatchError extends Schema.TaggedError<RuntimeDirectoryOwnerMismatchError>()(
  "RuntimeDirectoryOwnerMismatchError",
  {
    runtimeDir: Schema.String,
    expectedUserId: Schema.Number,
    actualUserId: Schema.Number,
  },
) {
  override get message(): string {
    return `Refusing to use runtime directory '${this.runtimeDir}' because it is owned by user ${this.actualUserId} instead of ${this.expectedUserId}.`;
  }
}

export class RuntimeDirectoryChmodError extends Schema.TaggedError<RuntimeDirectoryChmodError>()(
  "RuntimeDirectoryChmodError",
  {
    runtimeDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restrict runtime directory '${this.runtimeDir}' permissions.`;
  }
}

const legacyStorageIsInitialized = Effect.fn(function* (roots: T3StorageRoots) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(legacyT3StorageMigrationMarkerPath(roots, path))) return false;
  const results = yield* Effect.forEach(
    legacyT3StorageArtifactPaths(roots, path),
    (artifact) => fs.exists(artifact),
    { concurrency: "unbounded" },
  );
  return results.some(Boolean);
});

const prepareSplitRuntimeDirectory = Effect.fn("prepareSplitRuntimeDirectory")(function* (
  runtimeDir: string,
  userId: number,
) {
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
    catch: (cause) =>
      new RuntimeDirectoryOpenError({
        runtimeDir,
        cause,
      }),
  });

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.open(
          runtimeDir,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
        ),
      catch: (cause) =>
        new RuntimeDirectoryOpenError({
          runtimeDir,
          cause,
        }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const stat = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) =>
            new RuntimeDirectoryOpenError({
              runtimeDir,
              cause,
            }),
        });
        if (!stat.isDirectory()) {
          return yield* new RuntimeDirectoryNotADirectoryError({
            runtimeDir,
          });
        }
        if (stat.uid !== userId) {
          return yield* new RuntimeDirectoryOwnerMismatchError({
            runtimeDir,
            expectedUserId: userId,
            actualUserId: stat.uid,
          });
        }
        yield* Effect.tryPromise({
          try: () => handle.chmod(0o700),
          catch: (cause) =>
            new RuntimeDirectoryChmodError({
              runtimeDir,
              cause,
            }),
        });
      }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
  );
});

export interface StorageHost {
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
}

export const currentStorageHost = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return {
    homeDirectory: NodeOS.homedir(),
    temporaryDirectory: NodeOS.tmpdir(),
    platform,
    userId: platform === "win32" ? undefined : NodeOS.userInfo().uid,
  } satisfies StorageHost;
});

const storagePathOperations = (path: Path.Path) => ({
  join: (...paths: ReadonlyArray<string>) => path.join(...paths),
  resolve: (...paths: ReadonlyArray<string>) => path.resolve(...paths),
  isAbsolute: (candidate: string) => path.isAbsolute(candidate),
});

const storageEnvironmentRecord = (env: Config.Success<typeof EnvStorageConfig>) => ({
  T3CODE_CONFIG_DIR: env.t3ConfigDir,
  T3CODE_DATA_DIR: env.t3DataDir,
  T3CODE_STATE_DIR: env.t3StateDir,
  T3CODE_CACHE_DIR: env.t3CacheDir,
  T3CODE_RUNTIME_DIR: env.t3RuntimeDir,
  T3CODE_CLIENT_CONFIG_DIR: env.t3ClientConfigDir,
  T3CODE_CLIENT_STATE_DIR: env.t3ClientStateDir,
  T3CODE_CLIENT_CACHE_DIR: env.t3ClientCacheDir,
  XDG_CONFIG_HOME: env.xdgConfigHome,
  XDG_DATA_HOME: env.xdgDataHome,
  XDG_STATE_HOME: env.xdgStateHome,
  XDG_CACHE_HOME: env.xdgCacheHome,
  XDG_RUNTIME_DIR: env.xdgRuntimeDir,
  APPDATA: env.appData,
  LOCALAPPDATA: env.localAppData,
});

/** Directories a desktop client would use next to a server on `serverRoots`. */
export const resolveClientStorageRoots = Effect.fn("resolveClientStorageRoots")(function* (input: {
  readonly serverRoots: T3StorageRoots;
  readonly isDevelopment: boolean;
  readonly host: StorageHost;
}) {
  const path = yield* Path.Path;
  const env = yield* EnvStorageConfig;
  return resolveT3ClientStorageRoots({
    serverRoots: input.serverRoots,
    platform: input.host.platform,
    homeDirectory: input.host.homeDirectory,
    temporaryDirectory: input.host.temporaryDirectory,
    ...(input.host.userId === undefined ? {} : { userId: input.host.userId }),
    isDevelopment: input.isDevelopment,
    environment: storageEnvironmentRecord(env),
    path: storagePathOperations(path),
  });
});

/** The split roots for this host: platform defaults with any granular overrides applied. */
export const resolveSplitStorageRoots = Effect.fn("resolveSplitStorageRoots")(function* (input: {
  readonly isDevelopment: boolean;
  readonly host: StorageHost;
}) {
  const path = yield* Path.Path;
  const env = yield* EnvStorageConfig;
  const pathOperations = storagePathOperations(path);
  const environment = storageEnvironmentRecord(env);
  const defaults = resolveDefaultT3StorageRoots({
    platform: input.host.platform,
    homeDirectory: input.host.homeDirectory,
    temporaryDirectory: input.host.temporaryDirectory,
    ...(input.host.userId === undefined ? {} : { userId: input.host.userId }),
    isDevelopment: input.isDevelopment,
    environment,
    path: pathOperations,
  });
  return applyT3StorageDirectoryOverrides(
    defaults,
    resolveT3StorageDirectoryOverrides({
      environment,
      homeDirectory: input.host.homeDirectory,
      path: pathOperations,
    }),
  );
});

/**
 * Storage roots a server started with these flags would use: a desktop bootstrap pins them, then
 * --base-dir/T3CODE_HOME, granular directory overrides, a forced layout, and finally an initialized
 * legacy tree before the platform defaults. CLI commands that act on a server's files share this.
 */
export const resolveStorageRoots = Effect.fn("resolveStorageRoots")(function* (input: {
  readonly baseDir: Option.Option<string>;
  readonly storageLayout: Option.Option<CliStorageLayout>;
  readonly isDevelopment: boolean;
  readonly bootstrap?: Pick<DesktopBackendBootstrap, "storageRoots" | "t3Home">;
  readonly host: StorageHost;
}) {
  const path = yield* Path.Path;
  const env = yield* EnvStorageConfig;
  const { homeDirectory } = input.host;
  const { isDevelopment } = input;
  const stateDirectoryName = isDevelopment ? "dev" : "userdata";
  if (input.bootstrap?.storageRoots !== undefined) return input.bootstrap.storageRoots;
  if (input.bootstrap?.t3Home !== undefined) {
    return resolveLegacyT3StorageRoots({
      baseDir: yield* resolveBaseDir(input.bootstrap.t3Home),
      stateDirectoryName,
      path,
    });
  }

  const explicitBaseDir = resolveOptionPrecedence(
    input.baseDir,
    Option.fromUndefinedOr(env.t3Home),
  ).pipe(Option.filter((value) => value.trim().length > 0));
  const forcedStorageLayout = Option.getOrUndefined(input.storageLayout);
  const pathOperations = storagePathOperations(path);
  const storageEnvironment = storageEnvironmentRecord(env);
  const directoryOverrides = resolveT3StorageDirectoryOverrides({
    environment: storageEnvironment,
    homeDirectory,
    path: pathOperations,
  });
  const hasDirectoryOverrides = hasT3StorageDirectoryOverrides(directoryOverrides);
  if (Option.isSome(explicitBaseDir) && hasDirectoryOverrides) {
    return yield* new StorageDirectoryConfigurationConflictError();
  }
  if (forcedStorageLayout === "xdg" && Option.isSome(explicitBaseDir)) {
    return yield* new ForcedXdgLayoutConflictError();
  }
  if (forcedStorageLayout === "legacy" && hasDirectoryOverrides) {
    return yield* new ForcedLegacyLayoutConflictError();
  }
  const splitRoots = yield* resolveSplitStorageRoots(input);
  const explicitLegacyRoots = Option.isSome(explicitBaseDir)
    ? resolveLegacyT3StorageRoots({
        baseDir: yield* resolveBaseDir(explicitBaseDir.value),
        stateDirectoryName: "userdata",
        path,
      })
    : undefined;
  const legacyRoots = resolveLegacyT3StorageRoots({
    baseDir: path.join(homeDirectory, ".t3"),
    stateDirectoryName,
    path,
  });
  return selectT3StorageRoots({
    ...(forcedStorageLayout === "legacy"
      ? { explicitLegacyRoots: explicitLegacyRoots ?? legacyRoots }
      : explicitLegacyRoots === undefined
        ? {}
        : { explicitLegacyRoots }),
    ...(forcedStorageLayout === "xdg" || hasDirectoryOverrides
      ? { explicitSplitRoots: splitRoots }
      : {}),
    defaultSplitRoots: splitRoots,
    legacyRoots,
    legacyStorageInitialized: yield* legacyStorageIsInitialized(legacyRoots),
  });
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
    readonly homeDirectory?: string;
    readonly temporaryDirectory?: string;
    readonly userId?: number;
    readonly platform?: NodeJS.Platform;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      storageLayout: flags.storageLayout ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: ServerConfig.RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(ServerConfig.DEFAULT_PORT);
          }
          return findAvailablePort(ServerConfig.DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const devAuthToken =
      mode === "web" && devUrl !== undefined ? yield* DevAuthTokenConfig : undefined;
    const platform = options?.platform ?? (yield* HostProcessPlatform);
    const userId = options?.userId ?? (platform === "win32" ? undefined : NodeOS.userInfo().uid);
    const storageRoots = yield* resolveStorageRoots({
      baseDir: normalizedFlags.baseDir,
      storageLayout: normalizedFlags.storageLayout,
      isDevelopment: devUrl !== undefined,
      ...(bootstrap === undefined ? {} : { bootstrap }),
      host: {
        homeDirectory: options?.homeDirectory ?? NodeOS.homedir(),
        temporaryDirectory: options?.temporaryDirectory ?? NodeOS.tmpdir(),
        platform,
        userId,
      },
    });
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    if (
      storageRoots.layout === "legacy" &&
      (yield* fs.exists(legacyT3StorageMigrationMarkerPath(storageRoots, path)))
    ) {
      return yield* new LegacyStorageMigratedError({ stateDir: storageRoots.stateDir });
    }
    const derivedPaths = yield* ServerConfig.deriveServerPathsFromRoots(storageRoots);
    const baseDir = derivedPaths.dataDir;
    // An interactive CLI must not start over a discovered server. Lifetime locking
    // and supervisor handoff are separate; this preflight cannot arbitrate two starts.
    if (options?.rejectRunningServer && mode === "web") {
      const runtime = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
      if (Option.isSome(runtime) && runtime.value.pid > 0 && isProcessAlive(runtime.value.pid)) {
        return yield* new CliError.UserError({
          cause: `A T3 Code server is already running for ${baseDir} (pid ${runtime.value.pid}, ${runtime.value.origin}). Connect to that server, stop it before starting another, or use a different --base-dir.`,
        });
      }
    } else {
      // Supervised (`t3 serve`) and desktop-spawned servers restart after crashes,
      // so they yield only to a server that still answers at its recorded origin.
      const runtime = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
      if (Option.isSome(runtime) && (yield* isRespondingServerRuntime(runtime.value))) {
        return yield* new CliError.UserError({
          cause: `Another T3 Code server (pid ${runtime.value.pid}, ${runtime.value.origin}) already owns ${baseDir}. Two servers sharing one T3 home corrupt its state. Stop that server or use a different --base-dir.`,
        });
      }
    }
    yield* fs.makeDirectory(cwd, { recursive: true });
    if (platform !== "win32" && storageRoots.layout === "split" && userId !== undefined) {
      yield* prepareSplitRuntimeDirectory(derivedPaths.runtimeDir, userId);
    }
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const desktopBootstrapSecret = bootstrap?.desktopBootstrapSecret;
    const managedAccessToken = env.managedAccessToken?.trim() || undefined;
    const environmentIdOverride = env.environmentIdOverride?.trim() || undefined;
    const managedSettingsPath = env.managedSettingsFile?.trim() || undefined;
    const managedKeybindingsPath = env.managedKeybindingsFile?.trim() || undefined;
    const desktopTelemetryFd = bootstrap?.desktopTelemetryFd;
    const desktopTelemetryControlFd = bootstrap?.desktopTelemetryControlFd;
    const desktopBrowserFd = bootstrap?.desktopBrowserFd;
    const desktopBrowserControlFd = bootstrap?.desktopBrowserControlFd;
    const resourceMonitorPath = bootstrap?.resourceMonitorPath;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
      ),
      () => 443,
    );
    const staticDir = devUrl ? undefined : yield* ServerConfig.resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const otel = yield* OtelEnvironment.load;

    // T3 Code's own OTLP variables name no signal, so the one answer they give
    // is the answer for all three.
    const signalExport: SignalExport = {
      protocol: env.otlpProtocol,
      headers: env.otlpHeaders,
      exportIntervalMs: env.otlpExportIntervalMs,
    };
    const traces = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "traces",
      { url: env.otlpTracesUrl, export: signalExport },
      bootstrap?.otlpTracesUrl,
      persistedObservabilitySettings.otlpTracesUrl,
    );
    const metrics = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "metrics",
      { url: env.otlpMetricsUrl, export: signalExport },
      bootstrap?.otlpMetricsUrl,
      persistedObservabilitySettings.otlpMetricsUrl,
    );
    const logs = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "logs",
      { url: env.otlpLogsUrl, export: signalExport },
      bootstrap?.otlpLogsUrl,
      persistedObservabilitySettings.otlpLogsUrl,
    );

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl: traces?.url,
      otlpMetricsUrl: metrics?.url,
      otlpLogsUrl: logs?.url,
      otlpTracesExport: traces?.export ?? signalExport,
      otlpMetricsExport: metrics?.export ?? signalExport,
      otlpLogsExport: logs?.export ?? signalExport,
      otelEnvironment: otel,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      ...(devAuthToken === undefined ? {} : { devAuthToken }),
      devAllowedOrigins: env.devAllowedOrigins,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      ...(desktopBootstrapSecret === undefined ? {} : { desktopBootstrapSecret }),
      managedAccessToken,
      environmentIdOverride,
      desktopTelemetryFd,
      desktopTelemetryControlFd,
      desktopBrowserFd,
      desktopBrowserControlFd,
      resourceMonitorPath,
      ...(managedSettingsPath === undefined ? {} : { managedSettingsPath }),
      ...(managedKeybindingsPath === undefined ? {} : { managedKeybindingsPath }),
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      storageLayout: flags.storageLayout ?? Option.none(),
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
