import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  LEGACY_STORAGE_MIGRATION_MARKER,
  T3CODE_CLIENT_CONFIG_DIR_ENV,
  T3_STORAGE_ENVIRONMENT_NAMES,
} from "@t3tools/shared/storagePaths";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  isDevelopment ? "com.t3tools.T3Code.Development.desktop" : "com.t3tools.T3Code.desktop";

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

// Electron is not ready yet, so this mirrors DesktopEnvironment's storage selection cheaply: an
// initialized, unmigrated legacy tree wins, otherwise the split client config directory is used.
function resolveEarlyDesktopSettingsPaths(input: EarlyDesktopSettingsInput): ReadonlyArray<string> {
  const isDevelopment = isDevelopmentEnvironment(input.env);
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment,
    joinPath: input.joinPath,
    t3Home,
  });
  const legacyPath = input.joinPath(stateDir, "desktop-settings.json");
  if (trimNonEmpty(input.env.T3CODE_HOME) !== null) return [legacyPath];
  const clientConfigDir = trimNonEmpty(input.env[T3CODE_CLIENT_CONFIG_DIR_ENV]);
  const xdgConfigHome = trimNonEmpty(input.env.XDG_CONFIG_HOME);
  const configHome =
    xdgConfigHome?.startsWith("/") === true
      ? xdgConfigHome
      : input.joinPath(input.homeDirectory, ".config");
  const clientPath = input.joinPath(
    clientConfigDir ??
      input.joinPath(configHome, isDevelopment ? "t3code-client-dev" : "t3code-client"),
    "desktop-settings.json",
  );
  const splitIsExplicit = T3_STORAGE_ENVIRONMENT_NAMES.some(
    (name) => trimNonEmpty(input.env[name]) !== null,
  );
  const legacyMigrated = canRead(input, input.joinPath(stateDir, LEGACY_STORAGE_MIGRATION_MARKER));
  return splitIsExplicit || legacyMigrated ? [clientPath] : [legacyPath, clientPath];
}

const canRead = (input: EarlyDesktopSettingsInput, path: string): boolean => {
  try {
    input.readFileString(path);
    return true;
  } catch {
    return false;
  }
};

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  for (const settingsPath of resolveEarlyDesktopSettingsPaths(input)) {
    let raw: string;
    try {
      raw = input.readFileString(settingsPath);
    } catch {
      continue;
    }
    try {
      const parsed = decodeEarlyDesktopSettingsJson(raw);
      return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
    } catch {
      return DEFAULT_LINUX_PASSWORD_STORE;
    }
  }
  return DEFAULT_LINUX_PASSWORD_STORE;
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDevelopmentEnvironment(input.env);
  return {
    isDevelopment,
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment),
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
