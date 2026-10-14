import * as NetService from "@t3tools/shared/Net";
import {
  DEFAULT_SIGNAL_EXPORT,
  OtlpHeadersFromString,
  OtlpProtocol,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
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

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { readServerConfigFile } from "./serverConfigFile.ts";

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
    "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
  ),
  Flag.optional,
);
const serverConfigDirFlag = Flag.String("server-config-dir").pipe(
  Flag.withDescription(
    "Directory for settings.json, keybindings.json, and themes (equivalent to T3CODE_SERVER_CONFIG_DIR). Defaults to the base dir's state directory.",
  ),
  Flag.optional,
);
const serverDataDirFlag = Flag.String("server-data-dir").pipe(
  Flag.withDescription(
    "Directory for the database, secrets, attachments, logs, and worktrees (equivalent to T3CODE_SERVER_DATA_DIR). Defaults to the base dir's state directory, with worktrees beside it.",
  ),
  Flag.optional,
);
const serverCacheDirFlag = Flag.String("server-cache-dir").pipe(
  Flag.withDescription(
    "Directory for provider status caches (equivalent to T3CODE_SERVER_CACHE_DIR). Defaults to the base dir's caches directory.",
  ),
  Flag.optional,
);
const serverConfigFileFlag = Flag.String("server-config-file").pipe(
  Flag.withDescription(
    "JSON file of server options below flags and env vars (equivalent to T3CODE_SERVER_CONFIG_FILE). Defaults to server.json in the server config dir.",
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

export const traceFileConfig = Config.String("T3CODE_TRACE_FILE").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);
export const traceMaxFilesConfig = Config.Int("T3CODE_TRACE_MAX_FILES").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);
export const DEFAULT_TRACE_MAX_FILES = 10;

// No defaults here: unset values fall through to the server config file.
const EnvServerConfig = Config.all({
  logLevel: Config.LogLevel("T3CODE_LOG_LEVEL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMinLevel: Config.LogLevel("T3CODE_TRACE_MIN_LEVEL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceTimingEnabled: Config.Boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceFile: traceFileConfig,
  traceMaxBytes: Config.Int("T3CODE_TRACE_MAX_BYTES").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxFiles: traceMaxFilesConfig,
  traceBatchWindowMs: Config.Int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
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
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  mode: Config.schema(ServerConfig.RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.Port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.String("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
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

const nonEmptyEnv = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value.trim().length > 0)),
  );

const ServerLocationEnv = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option),
  serverConfigDir: nonEmptyEnv("T3CODE_SERVER_CONFIG_DIR"),
  serverDataDir: nonEmptyEnv("T3CODE_SERVER_DATA_DIR"),
  serverCacheDir: nonEmptyEnv("T3CODE_SERVER_CACHE_DIR"),
  serverConfigFile: nonEmptyEnv("T3CODE_SERVER_CONFIG_FILE"),
});

/** Where the server keeps its files. Each value is a flag that wins over its env var. */
export interface CliServerLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly serverConfigDir?: Option.Option<string>;
  readonly serverDataDir?: Option.Option<string>;
  readonly serverCacheDir?: Option.Option<string>;
  readonly serverConfigFile?: Option.Option<string>;
}

const resolveLocationOverride = Effect.fn(function* (
  flag: Option.Option<string> | undefined,
  env: Option.Option<string>,
) {
  const raw = Option.orElse(
    Option.filter(flag ?? Option.none(), (value) => value.trim().length > 0),
    () => env,
  );
  if (Option.isNone(raw)) return undefined;
  const path = yield* Path.Path;
  return path.resolve(yield* expandHomePath(raw.value.trim()));
});

/** The config, data, and cache overrides from flags, then env. */
export const resolveServerLocationOverrides = Effect.fn(function* (flags: CliServerLocationFlags) {
  const env = yield* ServerLocationEnv;
  return {
    configDir: yield* resolveLocationOverride(flags.serverConfigDir, env.serverConfigDir),
    dataDir: yield* resolveLocationOverride(flags.serverDataDir, env.serverDataDir),
    cacheDir: yield* resolveLocationOverride(flags.serverCacheDir, env.serverCacheDir),
  } satisfies ServerConfig.ServerLocationOverrides;
});

/**
 * Resolves the base dir (flag, then T3CODE_HOME, then `fallbackBaseDir`, then
 * `~/.t3`) and every server path. Every command that reads or writes server
 * files resolves through here so the CLI and the server agree.
 *
 * `ignoreLocationOverrides` derives every path from the base dir alone, as the
 * background service does, since it records only the base dir.
 */
export const resolveServerLocations = Effect.fn(function* (
  flags: CliServerLocationFlags,
  options: {
    readonly devUrl: URL | undefined;
    readonly fallbackBaseDir?: string | undefined;
    readonly ignoreLocationOverrides?: boolean | undefined;
  },
) {
  const env = yield* ServerLocationEnv;
  const explicitBaseDir = Option.orElse(flags.baseDir, () => env.t3Home).pipe(
    Option.filter((value) => value.trim().length > 0),
  );
  const baseDir = yield* resolveBaseDir(
    Option.getOrUndefined(explicitBaseDir) ?? options.fallbackBaseDir,
  );
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, options.devUrl, {
    baseDirIsExplicit: Option.isSome(explicitBaseDir),
    ...(options.ignoreLocationOverrides ? {} : yield* resolveServerLocationOverrides(flags)),
  });
  return { baseDir, derivedPaths };
});

/** The server config file named by the flag or env var, else server.json in `configDir`. */
export const resolveServerConfigFilePath = Effect.fn(function* (
  flags: CliServerLocationFlags,
  configDir: string,
) {
  const env = yield* ServerLocationEnv;
  const named = yield* resolveLocationOverride(flags.serverConfigFile, env.serverConfigFile);
  const path = yield* Path.Path;
  return { path: named ?? path.join(configDir, "server.json"), explicit: named !== undefined };
});

/** Reads the server config file. It holds options only, never locations. */
export const loadServerConfigFile = Effect.fn(function* (
  flags: CliServerLocationFlags,
  configDir: string,
) {
  const file = yield* resolveServerConfigFilePath(flags, configDir);
  return yield* readServerConfigFile(file.path, { explicit: file.explicit });
});

export interface CliServerFlags extends CliServerLocationFlags {
  readonly mode: Option.Option<ServerConfig.RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

export interface CliAuthLocationFlags extends CliServerLocationFlags {
  readonly devUrl?: Option.Option<URL>;
}

export const serverLocationFlags = {
  baseDir: baseDirFlag,
  serverConfigDir: serverConfigDirFlag,
  serverDataDir: serverDataDirFlag,
  serverCacheDir: serverCacheDirFlag,
  serverConfigFile: serverConfigFileFlag,
} as const;

export const authLocationFlags = {
  ...serverLocationFlags,
  devUrl: devUrlFlag,
} as const;

/**
 * Commands that manage the install (service, update, uninstall) record only
 * the base dir, so they take no server location overrides.
 */
export const installLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  ...serverLocationFlags,
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

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
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
      serverConfigDir: flags.serverConfigDir ?? Option.none(),
      serverDataDir: flags.serverDataDir ?? Option.none(),
      serverCacheDir: flags.serverCacheDir ?? Option.none(),
      serverConfigFile: flags.serverConfigFile ?? Option.none(),
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
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const { baseDir, derivedPaths } = yield* resolveServerLocations(normalizedFlags, {
      devUrl,
      fallbackBaseDir: bootstrap?.t3Home,
    });
    const file = yield* loadServerConfigFile(normalizedFlags, derivedPaths.configDir);

    const mode: ServerConfig.RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
        Option.fromUndefinedOr(file.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
        Option.fromUndefinedOr(file.port),
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
    const devAuthToken =
      mode === "web" && devUrl !== undefined ? yield* DevAuthTokenConfig : undefined;
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    // An interactive CLI must not start over a discovered server. Lifetime locking
    // and supervisor handoff are separate; this preflight cannot arbitrate two starts.
    if (options?.rejectRunningServer && mode === "web") {
      const runtime = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
      if (Option.isSome(runtime) && runtime.value.pid > 0 && isProcessAlive(runtime.value.pid)) {
        return yield* new CliError.UserError({
          cause: `A T3 Code server is already running for ${baseDir} (pid ${runtime.value.pid}, ${runtime.value.origin}). Connect to that server, stop it before starting another, or use a different --base-dir.`,
        });
      }
    }
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? file.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
        Option.fromUndefinedOr(file.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const desktopBootstrapSecret = bootstrap?.desktopBootstrapSecret;
    const shellEnvironmentPrepared = bootstrap?.shellEnvironmentPrepared;
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
        Option.fromUndefinedOr(file.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
        Option.fromUndefinedOr(file.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
        Option.fromUndefinedOr(file.tailscaleServePort),
      ),
      () => 443,
    );
    const staticDir = devUrl ? undefined : yield* ServerConfig.resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
        Option.fromUndefinedOr(file.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel ?? file.logLevel ?? "Info");

    const otel = yield* OtelEnvironment.load;

    const exportIntervalMs =
      env.otlpExportIntervalMs ??
      file.otlpExportIntervalMs ??
      DEFAULT_SIGNAL_EXPORT.exportIntervalMs;
    const signalExport: SignalExport = {
      protocol: env.otlpProtocol ?? DEFAULT_SIGNAL_EXPORT.protocol,
      headers: env.otlpHeaders,
      exportIntervalMs,
    };
    // A URL from the server config file exports only with the file's own
    // protocol and headers, never with credentials meant for another collector.
    const fileExport: SignalExport = {
      protocol: file.otlpProtocol ?? DEFAULT_SIGNAL_EXPORT.protocol,
      headers: file.otlpHeaders,
      exportIntervalMs,
    };
    const fileEndpoint = (url: string | undefined) =>
      url === undefined ? undefined : { url, export: fileExport };
    const traces = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "traces",
      { url: env.otlpTracesUrl, export: signalExport },
      bootstrap?.otlpTracesUrl,
      fileEndpoint(file.otlpTracesUrl),
      persistedObservabilitySettings.otlpTracesUrl,
    );
    const metrics = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "metrics",
      { url: env.otlpMetricsUrl, export: signalExport },
      bootstrap?.otlpMetricsUrl,
      fileEndpoint(file.otlpMetricsUrl),
      persistedObservabilitySettings.otlpMetricsUrl,
    );
    const logs = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "logs",
      { url: env.otlpLogsUrl, export: signalExport },
      bootstrap?.otlpLogsUrl,
      fileEndpoint(file.otlpLogsUrl),
      persistedObservabilitySettings.otlpLogsUrl,
    );

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel ?? file.traceMinLevel ?? "Info",
      traceTimingEnabled: env.traceTimingEnabled ?? file.traceTimingEnabled ?? true,
      traceBatchWindowMs: env.traceBatchWindowMs ?? file.traceBatchWindowMs ?? 1_000,
      traceMaxBytes: env.traceMaxBytes ?? file.traceMaxBytes ?? 10 * 1024 * 1024,
      traceMaxFiles: env.traceMaxFiles ?? file.traceMaxFiles ?? DEFAULT_TRACE_MAX_FILES,
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
      ...(shellEnvironmentPrepared === undefined ? {} : { shellEnvironmentPrepared }),
      desktopTelemetryFd,
      desktopTelemetryControlFd,
      desktopBrowserFd,
      desktopBrowserControlFd,
      resourceMonitorPath,
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
      serverConfigDir: flags.serverConfigDir ?? Option.none(),
      serverDataDir: flags.serverDataDir ?? Option.none(),
      serverCacheDir: flags.serverCacheDir ?? Option.none(),
      serverConfigFile: flags.serverConfigFile ?? Option.none(),
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

/**
 * Paths for the install commands (service, update, uninstall). They come from
 * the base dir alone so they agree with the service they manage, which runs
 * without the location overrides whatever the invoking shell sets. Creates
 * nothing on disk.
 */
export const resolveInstallLocations = Effect.fn(function* (flags: {
  readonly baseDir: Option.Option<string>;
}) {
  const { baseDir, derivedPaths } = yield* resolveServerLocations(flags, {
    devUrl: undefined,
    ignoreLocationOverrides: true,
  });
  return { ...derivedPaths, baseDir };
});

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
