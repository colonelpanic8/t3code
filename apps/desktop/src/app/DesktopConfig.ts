import { OtlpHeadersFromString, OtlpProtocol } from "@t3tools/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.Boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

export interface DesktopUpdateNoticeFeed {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
}

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export const isFullCommitSha = (value: string): boolean => COMMIT_SHA.test(value);

const isGitHubRepository = (repository: string): boolean => {
  const segments = repository.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => segment !== "." && segment !== ".." && GITHUB_REPOSITORY_SEGMENT.test(segment),
    )
  );
};

const updateNoticeFeed = Config.all({
  repository: trimmedString("T3CODE_UPDATE_NOTICE_REPOSITORY"),
  branch: trimmedString("T3CODE_UPDATE_NOTICE_BRANCH"),
  commit: trimmedString("T3CODE_UPDATE_NOTICE_COMMIT").pipe(
    Config.map(Option.map((commit) => commit.toLowerCase())),
  ),
}).pipe(
  Config.map((feed): Option.Option<DesktopUpdateNoticeFeed> =>
    Option.all(feed).pipe(
      Option.filter(
        ({ repository, commit }) => isGitHubRepository(repository) && isFullCommitSha(commit),
      ),
    ),
  ),
);

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedString("T3CODE_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("T3CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.Port("T3CODE_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("T3CODE_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("T3CODE_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("T3CODE_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  desktopLauncherPath: trimmedString("T3CODE_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("T3CODE_DISABLE_AUTO_UPDATE"),
  updateNoticeFeed,
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.Port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
