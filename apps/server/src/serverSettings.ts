import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_WORKTREE_PATH_TEMPLATE,
  EasDeviceHostConfig,
  ManagedSettingWriteError,
  type ManagedSettingPaths,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  ProviderInstanceConfig,
  type ProviderInstanceMutation,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import { mapSettingsSecrets, SECRET_REDACTED, type SettingsSecret } from "./settingsSecrets.ts";

export {
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsDocument = Schema.encodeUnknownEffect(ServerSettings);
const encodeSettingsDocumentJson = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Old settings files can hold both flags with conflicting values; an explicit false on either
 * side wins so a user's disable is never silently undone.
 */
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Only fold boolean flags: a malformed `enabled` (e.g. `"false"`) must
    // stay in the blob so driver schema validation flags it instead of the
    // fold silently repairing the config.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  return mapSettingsSecrets(settings, (secret) =>
    secret.sensitive
      ? { value: "", redacted: secret.redacted || secret.value.length > 0 }
      : { value: secret.value, redacted: false },
  );
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    settings.providerInstances[mutation.instanceId] !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;

    readonly ready: Effect.Effect<void, ServerSettingsError>;

    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly managedSettingPaths: Effect.Effect<ManagedSettingPaths, ServerSettingsError>;

    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError | ManagedSettingWriteError>;

    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError | ManagedSettingWriteError>;

    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Use this before reading a snapshot when changes between the snapshot and
     * a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = Effect.fn("serverSettings.makeTest")(function* (
  overrides: DeepPartial<ServerSettings> = {},
) {
  const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
    overrides;
  const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
  const initialSettings = yield* normalizeServerSettings({
    ...merged,
    ...(automaticGitFetchInterval !== undefined
      ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
      : {}),
    ...(providerHealthRefreshInterval !== undefined
      ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
      : {}),
  });
  const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
  const writeSemaphore = yield* Semaphore.make(1);
  const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

  const updateTestSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Ref.get(currentSettingsRef).pipe(
        Effect.flatMap(update),
        Effect.flatMap(normalizeServerSettings),
        Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
        Effect.map(resolveTextGenerationProvider),
      ),
    );

  return {
    start: Effect.void,
    ready: Effect.void,
    getSettings,
    managedSettingPaths: Effect.succeed([]),
    updateSettings: (patch) =>
      updateTestSettings((currentSettings) =>
        Effect.succeed(applyServerSettingsPatch(currentSettings, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(currentSettings, mutation, "test settings");
          const patched = applyServerSettingsPatch(currentSettings, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    withSettingsSnapshot: (use) =>
      writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettingsService["Service"];
});

/** The configured worktree path template; falls back to the default when settings cannot be read. */
export const readWorktreePathTemplate = (serverSettings: ServerSettingsService["Service"]) =>
  serverSettings.getSettings.pipe(
    Effect.flatMap((settings) =>
      HostProcess.HomeDirectory.pipe(
        Effect.map((home) => expandHomePath(settings.worktreePathTemplate, home)),
      ),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read worktree path template; using the default", {
        cause,
      }).pipe(Effect.as(DEFAULT_WORKTREE_PATH_TEMPLATE)),
    ),
  );

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

// Migrate saved token delivery without accepting it in settings writes or
// letting one retired value reset the rest of the environment's settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const PersistedServerSettings = Schema.Struct({
  ...ServerSettings.fields,
  responseStreamingMode: PersistedResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  projectSettingsOverrides: Schema.Record(
    ProjectId,
    Schema.Struct({
      ...ProjectSettingsOverrides.fields,
      responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
const decodePersistedServerSettingsExit = Schema.decodeUnknownExit(PersistedServerSettings);
const decodeSettingsDocumentExit = Schema.decodeUnknownExit(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);

const LEGACY_BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};
const legacyGitHubTokenSecretName = (host: string) =>
  `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;

function dropUnstoredPlaceholders(
  blob: Readonly<Record<string, unknown>>,
  unstored: ReadonlySet<string>,
  legacyName: (field: string, serverHost: string | null) => string | undefined,
): Record<string, unknown> {
  const isUnstored = (value: unknown, field: string, serverHost: string | null) => {
    if (value !== SECRET_REDACTED) return false;
    const name = legacyName(field, serverHost);
    return name !== undefined && unstored.has(name);
  };
  const next: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(blob)) {
    if (isUnstored(value, field, null)) continue;
    next[field] = isSettingsDocument(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([serverHost, entry]) => !isUnstored(entry, field, serverHost),
          ),
        )
      : value;
  }
  return next;
}

function migrateLegacySourceControlSettings(
  settings: ServerSettings,
  legacy: {
    readonly bitbucket?: Readonly<Record<string, unknown>> | undefined;
    readonly github?: Readonly<Record<string, unknown>> | undefined;
  },
  localKinds: ReadonlySet<string>,
  unstoredSecrets: ReadonlySet<string> = new Set(),
): {
  readonly settings: ServerSettings;
  readonly secretMoves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** Host spellings the folded blobs repeated; the last of each was kept. */
  readonly duplicates: number;
} {
  const sourceControlHosts = { ...settings.sourceControlHosts };
  const secretMoves: Array<{ readonly from: string; readonly to: string }> = [];
  let duplicates = 0;
  const fold = (
    kind: string,
    blob: Readonly<Record<string, unknown>>,
    legacyName: (field: string, serverHost: string | null) => string | undefined,
  ) => {
    const shared = sourceControlHosts[kind];
    if (shared === undefined) {
      sourceControlHosts[kind] = blob;
      return;
    }
    const folded = canonicalizeSecretFields({
      sourceControlHosts: { [kind]: dropUnstoredPlaceholders(blob, unstoredSecrets, legacyName) },
    });
    duplicates += folded.duplicates;
    const hosts = folded.document.sourceControlHosts as SettingsDocument;
    sourceControlHosts[kind] = layerSettingsDocuments(shared, hosts[kind] as SettingsDocument);
  };
  if (legacy.bitbucket !== undefined && !localKinds.has("bitbucket")) {
    fold("bitbucket", legacy.bitbucket, (field, serverHost) =>
      serverHost === null ? LEGACY_BITBUCKET_SECRET_NAMES[field] : undefined,
    );
    for (const [field, from] of Object.entries(LEGACY_BITBUCKET_SECRET_NAMES)) {
      if (legacy.bitbucket[field] !== SECRET_REDACTED) continue;
      secretMoves.push({
        from,
        to: sourceControlHostSecretName({ kind: "bitbucket", field, serverHost: null }),
      });
    }
  }
  if (legacy.github !== undefined && !localKinds.has("github")) {
    fold("github", legacy.github, (field, serverHost) =>
      field === "tokens" && serverHost !== null
        ? legacyGitHubTokenSecretName(serverHost)
        : undefined,
    );
    for (const [serverHost, value] of readSecretFieldValues(legacy.github.tokens)) {
      if (serverHost === null || value !== SECRET_REDACTED) continue;
      secretMoves.push({
        from: legacyGitHubTokenSecretName(serverHost),
        to: sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost }),
      });
    }
  }
  return { settings: { ...settings, sourceControlHosts }, secretMoves, duplicates };
}

const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
  /** Instances settings.json itself configures; a shared one is replaced by the migrated slot. */
  localInstanceIds: ReadonlySet<string>,
): ServerSettings {
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || blob === null || typeof blob !== "object") continue;
    if (Array.isArray(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    const { enabled: rawEnabled, ...config } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    if (localInstanceIds.has(instanceId)) continue;
    // An enabled-only blob keeps an inherited entry's config, and one matching the
    // inherited state keeps the entry itself. Without a flag, the loop above already
    // enabled it if history shows use.
    const inherited = settings.providerInstances[instanceId];
    if (inherited !== undefined && Object.keys(config).length === 0) {
      if (explicitEnabled !== undefined) {
        providerInstances[instanceId] =
          explicitEnabled === resolveProviderInstanceEnabled(inherited)
            ? inherited
            : { ...inherited, enabled: explicitEnabled };
      }
      continue;
    }
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (Object.keys(config).length === 0 && (enabled === undefined || enabled === driverDefault)) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return fallback === null ? settings : { ...settings, textGenerationModelSelection: fallback };
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "textGenerationModelSelection",
  "pullRequestMergeMethod",
  "worktreeCleanup",
]);

// Maps whose entries are compared as a whole: a partial entry fails to decode,
// and a driver's config blob only means anything next to that driver.
const ATOMIC_ENTRY_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "providerInstances",
  "usageLimitSources",
  "usagePriceOverrides",
]);

const isAtomicSettingsValue = (key: string, inAtomicEntryMap: boolean) =>
  inAtomicEntryMap || ATOMIC_SETTINGS_KEYS.has(key);

function stripDefaultServerSettings(
  current: unknown,
  defaults: unknown,
  inAtomicEntryMap = false,
): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (isAtomicSettingsValue(key, inAtomicEntryMap)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(
          currentRecord[key],
          defaultsRecord[key],
          ATOMIC_ENTRY_SETTINGS_KEYS.has(key),
        );
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

type SettingsDocument = Record<string, unknown>;

const isSettingsDocument = (value: unknown): value is SettingsDocument =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SECRET_SECTIONS = ["providerInstances", "sourceControlHosts", "usageLimitSources"] as const;

/** Whether `mapSettingsSecrets` can walk a raw entry; the decoder rejects the rest. */
const isWalkableSecretEntry = (section: string, entry: unknown) =>
  isSettingsDocument(entry) &&
  (section !== "providerInstances" ||
    entry.environment === undefined ||
    (Array.isArray(entry.environment) &&
      entry.environment.every(
        (variable) => isSettingsDocument(variable) && typeof variable.name === "string",
      )));

/**
 * Rewrites a raw settings document's secret fields into the form `mapSettingsSecrets` saves:
 * host keys trimmed and lowercased, `valueRedacted: false` dropped, non-string values removed.
 * Canonical documents layer per host, so settings.json wins for each host it names, and inherited
 * shared values match what a save produces. Of several spellings of one host in a document the
 * last wins; `duplicates` counts the rest.
 */
function canonicalizeSecretFields(document: SettingsDocument): {
  readonly document: SettingsDocument;
  readonly duplicates: number;
} {
  const sections: Record<string, SettingsDocument> = {};
  for (const section of SECRET_SECTIONS) {
    const value = document[section];
    if (!isSettingsDocument(value)) continue;
    sections[section] = Object.fromEntries(
      Object.entries(value).filter(([, entry]) => isWalkableSecretEntry(section, entry)),
    );
  }
  if (Object.keys(sections).length === 0) return { document, duplicates: 0 };
  const seen = new Set<string>();
  let duplicates = 0;
  const canonical = mapSettingsSecrets(
    {
      ...DEFAULT_SERVER_SETTINGS,
      ...sections,
    } as unknown as ServerSettings,
    (secret) => {
      if (secret.kind === "field") {
        if (seen.has(secret.secretName)) duplicates += 1;
        seen.add(secret.secretName);
      }
      return secret;
    },
  ) as unknown as Record<string, SettingsDocument>;
  const next = { ...document };
  for (const section of Object.keys(sections)) {
    next[section] = { ...(document[section] as SettingsDocument), ...canonical[section] };
  }
  return { document: next, duplicates };
}

/**
 * The inverse of `stripDefaultServerSettings`: objects merge key by key, while
 * atomic values, arrays, and scalars from `top` replace what `base` holds.
 */
function layerSettingsDocuments(
  base: SettingsDocument,
  top: SettingsDocument,
  inAtomicEntryMap = false,
): SettingsDocument {
  const next = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const below = next[key];
    next[key] =
      !isAtomicSettingsValue(key, inAtomicEntryMap) &&
      isSettingsDocument(value) &&
      isSettingsDocument(below)
        ? layerSettingsDocuments(below, value, ATOMIC_ENTRY_SETTINGS_KEYS.has(key))
        : value;
  }
  return next;
}

/** Adds back every key path `document` holds, taking its value from `settings`. */
function restoreDocumentKeys(
  sparse: SettingsDocument,
  settings: SettingsDocument,
  document: SettingsDocument,
  inAtomicEntryMap = false,
): SettingsDocument {
  const next = { ...sparse };
  for (const [key, below] of Object.entries(document)) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    const kept = next[key];
    next[key] =
      !isAtomicSettingsValue(key, inAtomicEntryMap) &&
      isSettingsDocument(value) &&
      isSettingsDocument(below)
        ? restoreDocumentKeys(
            isSettingsDocument(kept) ? kept : {},
            value,
            below,
            ATOMIC_ENTRY_SETTINGS_KEYS.has(key),
          )
        : value;
  }
  return next;
}

/**
 * Sensitive values the shared settings file supplies in plaintext, keyed by
 * secret name, for the entries `settings` still inherits unchanged. An edited
 * entry is saved whole to settings.json, so its secrets must go to the store.
 * Redacted secrets in `settings` compare by the value `resolvedValues` gives them;
 * one it lacks stays redacted, so it never matches a shared value or placeholder.
 */
function inheritedSecretValues(
  settings: ServerSettings,
  baseline: ServerSettings,
  resolvedValues: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const withPlainSecrets = (value: ServerSettings, stored: ReadonlyMap<string, string>) =>
    mapSettingsSecrets(value, (secret) => {
      const resolved =
        secret.sensitive && secret.redacted ? stored.get(secret.secretName) : undefined;
      return resolved === undefined ? secret : { value: resolved, redacted: false };
    });
  const ours = withPlainSecrets(settings, resolvedValues);
  const theirs = withPlainSecrets(baseline, new Map());
  const unchanged = <K extends "providerInstances" | "usageLimitSources">(key: K) =>
    Object.fromEntries(
      Object.entries(baseline[key]).filter(([id]) =>
        Equal.equals(
          (ours[key] as Record<string, unknown>)[id],
          (theirs[key] as Record<string, unknown>)[id],
        ),
      ),
    ) as ServerSettings[K];
  const inherited: ServerSettings = {
    ...baseline,
    providerInstances: unchanged("providerInstances"),
    usageLimitSources: unchanged("usageLimitSources"),
  };
  const values = new Map<string, string>();
  mapSettingsSecrets(inherited, (secret) => {
    if (secret.sensitive && !secret.redacted && secret.value.length > 0) {
      values.set(secret.secretName, secret.value);
    }
    return secret;
  });
  return values;
}

interface SettingsLayer {
  /**
   * What a key missing from settings.json resolves to: the defaults, with the
   * shared settings file applied when one is configured. settings.json
   * persists only where `settings` differs from it.
   */
  readonly baseline: ServerSettings;
  /**
   * The shared file is configured but missing or unusable, so `baseline` may
   * lack values settings.json overrides; every key settings.json holds is kept.
   */
  readonly keepLocalKeys: boolean;
}

/** Managed values are leaves wherever the shared layering would replace instead of merge. */
function managedLeafPaths(
  document: SettingsDocument,
  prefix: ReadonlyArray<string> = [],
  inAtomicEntryMap = false,
): string[][] {
  return Object.entries(document).flatMap(([key, value]) =>
    !isAtomicSettingsValue(key, inAtomicEntryMap) && isSettingsDocument(value)
      ? managedLeafPaths(value, [...prefix, key], ATOMIC_ENTRY_SETTINGS_KEYS.has(key))
      : [[...prefix, key]],
  );
}

/**
 * Put back what `settings` holds at every managed path, so a write against the
 * effective settings never persists a managed value. `settings` is the layer
 * beneath the managed one; stripping it against the baseline leaves exactly
 * what settings.json holds there. Objects that exist only because the managed
 * layer created them are dropped again.
 */
function restoreUnmanagedSettings(
  next: SettingsDocument,
  settings: SettingsDocument | undefined,
  managed: SettingsDocument,
  inAtomicEntryMap = false,
): SettingsDocument {
  const restored = { ...next };
  for (const [key, value] of Object.entries(managed)) {
    const nested = restored[key];
    const settingsHasKey = settings !== undefined && Object.hasOwn(settings, key);
    if (
      !isAtomicSettingsValue(key, inAtomicEntryMap) &&
      isSettingsDocument(value) &&
      isSettingsDocument(nested)
    ) {
      const below = settings?.[key];
      const child = restoreUnmanagedSettings(
        nested,
        isSettingsDocument(below) ? below : undefined,
        value,
        ATOMIC_ENTRY_SETTINGS_KEYS.has(key),
      );
      if (Object.keys(child).length === 0 && !settingsHasKey) delete restored[key];
      else restored[key] = child;
    } else if (settingsHasKey) {
      restored[key] = settings[key];
    } else {
      delete restored[key];
    }
  }
  return restored;
}

interface ManagedEntry {
  readonly key: string;
  /** `key`, or `key.id` for one whole entry of an atomic entry map, for warnings. */
  readonly setting: string;
  readonly document: SettingsDocument;
}

/** What the managed layer is checked by: each top-level key, or each whole atomic entry. */
function managedEntries(document: SettingsDocument): ReadonlyArray<ManagedEntry> {
  return Object.entries(document).flatMap(([key, value]): ManagedEntry[] =>
    ATOMIC_ENTRY_SETTINGS_KEYS.has(key) && isSettingsDocument(value)
      ? Object.entries(value).map(([id, entry]) => ({
          key,
          setting: `${key}.${id}`,
          document: { [key]: { [id]: entry } },
        }))
      : [{ key, setting: key, document: { [key]: value } }],
  );
}

const isFileReference = (value: unknown): value is { readonly $file: string } =>
  isSettingsDocument(value) && typeof value.$file === "string" && Object.keys(value).length === 1;

const hasFileReference = (value: unknown): boolean =>
  isFileReference(value) ||
  (Array.isArray(value)
    ? value.some(hasFileReference)
    : isSettingsDocument(value) && Object.values(value).some(hasFileReference));

const markFileReferences = (value: unknown): unknown =>
  isFileReference(value)
    ? SECRET_REDACTED
    : Array.isArray(value)
      ? value.map(markFileReferences)
      : isSettingsDocument(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, markFileReferences(entry)]),
          )
        : value;

// A managed environment value comes from the file or a reference, never from the secret store.
const dropRedactionFlags = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(dropRedactionFlags)
    : isSettingsDocument(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([key, entry]) =>
            key === "valueRedacted" ? [] : [[key, dropRedactionFlags(entry)]],
          ),
        )
      : value;

// A value read from a secret file is sensitive whatever its environment entry says.
const markReferencedEnvironmentSensitive = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(markReferencedEnvironmentSensitive)
    : isSettingsDocument(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            key === "environment" && Array.isArray(entry)
              ? entry.map((variable) =>
                  isSettingsDocument(variable) && isFileReference(variable.value)
                    ? { ...variable, sensitive: true }
                    : variable,
                )
              : markReferencedEnvironmentSensitive(entry),
          ]),
        )
      : value;

// Normalizing rebuilds these from `projectSettingsOverrides`, so a managed value would never hold.
const DERIVED_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  Object.keys(deriveLegacyProjectOverrides({ projectSettingsOverrides: {} })),
);

function readSettingsPath(document: unknown, path: ReadonlyArray<string>): unknown {
  return path.reduce<unknown>(
    (current, segment) => (isSettingsDocument(current) ? current[segment] : undefined),
    document,
  );
}

/** Paths to the keys of a managed value that `kept` lacks, walking objects and arrays. */
function missingKeyPaths(
  managed: unknown,
  kept: unknown,
  prefix: ReadonlyArray<string>,
): string[][] {
  if (Array.isArray(managed)) {
    return managed.flatMap((entry, index) =>
      missingKeyPaths(entry, Array.isArray(kept) ? kept[index] : undefined, [
        ...prefix,
        String(index),
      ]),
    );
  }
  if (!isSettingsDocument(managed)) return [];
  return Object.entries(managed).flatMap(([key, value]) =>
    isSettingsDocument(kept) && Object.hasOwn(kept, key)
      ? missingKeyPaths(value, kept[key], [...prefix, key])
      : [[...prefix, key]],
  );
}

/** `value` without the key at `path`; array indices are path segments too. */
function withoutSettingsKey(value: unknown, path: ReadonlyArray<string>): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      String(index) === head ? withoutSettingsKey(entry, rest) : entry,
    );
  }
  if (!isSettingsDocument(value)) return value;
  if (rest.length === 0) {
    const { [head]: _removed, ...remaining } = value;
    return remaining;
  }
  return { ...value, [head]: withoutSettingsKey(value[head], rest) };
}

const decodeProviderInstanceOption = Schema.decodeUnknownOption(ProviderInstanceConfig);
const decodeUsageLimitSourceOption = Schema.decodeUnknownOption(UsageLimitSourceConfig);
const decodeEasDeviceHostOption = Schema.decodeUnknownOption(EasDeviceHostConfig);

/** The entries of `map` that decode. */
function decodedEntries(
  map: unknown,
  decode: (entry: unknown) => Option.Option<unknown>,
): Array<readonly [string, unknown]> {
  if (!isSettingsDocument(map)) return [];
  return Object.entries(map).flatMap(([id, entry]) =>
    Option.match(decode(entry), {
      onNone: () => [],
      onSome: (decoded) => [[id, decoded] as const],
    }),
  );
}

/** The entries of `map` that are objects `keep` accepts. */
function rawEntries(
  map: unknown,
  keep: (entry: unknown) => boolean = isSettingsDocument,
): Record<string, unknown> {
  return isSettingsDocument(map)
    ? Object.fromEntries(Object.entries(map).filter(([, entry]) => keep(entry)))
    : {};
}

/**
 * Visits the credential positions of a managed document: environment values and schema-declared
 * secret fields. Entries are walked twice: decoded, so secret fields resolve by the driver names
 * and defaults the runtime sees, and raw, so an entry that fails to decode cannot hide one.
 */
function walkManagedSecrets(
  marked: SettingsDocument,
  visit: (secret: SettingsSecret) => void,
): void {
  const hosts = Array.isArray(marked.easDeviceHosts)
    ? marked.easDeviceHosts.filter(isSettingsDocument)
    : [];
  const decoded = {
    easDeviceHosts: hosts.flatMap((host) => Option.toArray(decodeEasDeviceHostOption(host))),
    providerInstances: Object.fromEntries(
      decodedEntries(marked.providerInstances, decodeProviderInstanceOption),
    ),
    sourceControlHosts: rawEntries(marked.sourceControlHosts),
    usageLimitSources: Object.fromEntries(
      decodedEntries(marked.usageLimitSources, decodeUsageLimitSourceOption),
    ),
  };
  const raw = {
    easDeviceHosts: hosts.map((host, index) => ({
      ...host,
      id: typeof host.id === "string" ? host.id : `managed-${index}`,
    })),
    providerInstances: rawEntries(marked.providerInstances, (entry) =>
      isWalkableSecretEntry("providerInstances", entry),
    ),
    sourceControlHosts: decoded.sourceControlHosts,
    usageLimitSources: rawEntries(marked.usageLimitSources),
  };
  for (const sections of [decoded, raw]) {
    mapSettingsSecrets(
      { ...DEFAULT_SERVER_SETTINGS, ...sections } as unknown as ServerSettings,
      (secret) => {
        visit(secret);
        return secret;
      },
    );
  }
}

// Credentials reach the managed file only as `{ "$file": "/path" }`, since the
// file itself usually lives somewhere world-readable such as the Nix store.
// Project provider overrides accept only `enabled`, so any `config` or
// `environment` there counts as inline.
// Returns a description of the first credential written inline.
function findInlineManagedSecret(document: SettingsDocument): string | undefined {
  const marked = markFileReferences(document) as SettingsDocument;
  for (const [projectId, project] of Object.entries(rawEntries(marked.projectSettingsOverrides))) {
    const instances = rawEntries((project as SettingsDocument).providerInstances);
    for (const [instanceId, instance] of Object.entries(instances)) {
      const key = ["config", "environment"].find((field) => field in (instance as object));
      if (key !== undefined) {
        return `projectSettingsOverrides.${projectId}.providerInstances.${instanceId}.${key}`;
      }
    }
  }
  let inline: string | undefined;
  walkManagedSecrets(marked, (secret) => {
    const value = typeof secret.value === "string" ? secret.value.trim() : "";
    if (secret.sensitive && value.length > 0 && value !== SECRET_REDACTED) {
      inline ??= `secret ${secret.secretName}`;
    }
  });
  return inline;
}

/**
 * Whether `document` holds a `$file` reference outside a credential position. Client redaction
 * only hides credentials, so such a value would reach clients in plaintext.
 */
function hasMisplacedFileReference(document: SettingsDocument): boolean {
  const unvisited = new Set<string>();
  const tokenize = (value: unknown): unknown => {
    if (isFileReference(value)) {
      const token = `t3-managed-file-reference-${unvisited.size}`;
      unvisited.add(token);
      return token;
    }
    if (Array.isArray(value)) return value.map(tokenize);
    return isSettingsDocument(value)
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, tokenize(entry)]))
      : value;
  };
  const tokenized = tokenize(document) as SettingsDocument;
  if (unvisited.size === 0) return false;
  walkManagedSecrets(tokenized, (secret) => unvisited.delete(secret.value));
  return unvisited.size > 0;
}

interface ManagedSettingsLayer {
  readonly document: SettingsDocument;
  readonly paths: ManagedSettingPaths;
  /** Settings holding values read from `$file` references, whose schema errors are not logged. */
  readonly fromFiles: ReadonlySet<string>;
}

interface SettingsState extends SettingsLayer {
  readonly parseFailure: Option.Option<unknown>;
  /** Defaults, shared file, then settings.json: the layers writes persist into. */
  readonly settings: ServerSettings;
  /** `settings` with the managed layer applied; what everything else reads. */
  readonly effective: ServerSettings;
  readonly managed: ManagedSettingsLayer | undefined;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

/**
 * Marked with `projectSettingsFolded` so a later reset in the UI survives restarts.
 */
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null meant "reset to machine defaults", which is now plain
  // inheritance; the project's own aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath, sharedSettingsPath, managedSettingsPath } =
    yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const readLocalDocument = Effect.gen(function* () {
    if (!(yield* readConfigExists)) return {};
    const document = decodeSettingsDocumentExit(yield* readRawConfig);
    return Exit.isSuccess(document) ? document.value : {};
  });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings, layer: SettingsLayer) {
      const sparse = (stripDefaultServerSettings(settings, layer.baseline) ??
        {}) as SettingsDocument;
      const document = layer.keepLocalKeys
        ? restoreDocumentKeys(sparse, settings, yield* readLocalDocument)
        : sparse;
      const encoded = yield* encodeServerSettingsDocument(document);
      // Some fields encode null as a missing key, which would let the shared value win again.
      const nulls = Object.keys(document).filter(
        (key) => document[key] === null && !Object.hasOwn(encoded, key),
      );
      const sparseSettingsJson = yield* encodeSettingsDocumentJson({
        ...encoded,
        ...Object.fromEntries(nulls.map((key) => [key, null])),
      });

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings, baseline: ServerSettings) {
      // A secret the shared file supplies stays there; moving it would pin a copy in settings.json.
      const inherited = inheritedSecretValues(settings, baseline);
      const shared = new Map<string, string>();
      mapSettingsSecrets(baseline, (secret) => {
        if (secret.sensitive && !secret.redacted) shared.set(secret.secretName, secret.value);
        return secret;
      });
      const isShared = (secret: SettingsSecret) => shared.get(secret.secretName) === secret.value;
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (
          secret.sensitive &&
          (secret.kind === "field" || isShared(secret)) &&
          !secret.redacted &&
          secret.value.length > 0 &&
          inherited.get(secret.secretName) !== secret.value
        ) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending.filter((secret) => !isShared(secret))) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      const sharedPending = pending.filter(isShared);
      const rollbackSharedSecrets = yield* applySettingsSecretChanges(
        sharedPending.map((secret) => ({
          kind: "write" as const,
          secretName: secret.secretName,
          value: textEncoder.encode(secret.value),
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        })),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("failed to move shared settings secrets into the secret store").pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (rollbackSharedSecrets !== undefined) {
        for (const secret of sharedPending) moved.add(secret.secretName);
      }
      return {
        settings:
          moved.size === 0
            ? settings
            : mapSettingsSecrets(settings, (secret) =>
                moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
              ),
        sharedSecretLeftInline: rollbackSharedSecrets === undefined,
        rollbackSharedSecrets: rollbackSharedSecrets ?? Effect.void,
      };
    },
  );

  interface SharedSettings {
    readonly document: SettingsDocument;
    readonly baseline: ServerSettings;
    readonly status: "loaded" | "missing" | "unusable";
  }

  // An unusable shared file is ignored the way an unusable settings.json is.
  const unusableSharedSettings = (cause: unknown) =>
    Effect.logWarning("failed to read the shared settings file, ignoring it", {
      path: sharedSettingsPath,
      cause,
    }).pipe(
      Effect.as<SharedSettings>({
        // It may hold an opt-out we can no longer read; never resume threads on a guess.
        document: { continueThreadsAfterServerUpdate: false },
        baseline: { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: false },
        status: "unusable",
      }),
    );

  const warnDuplicateSecretHosts = (path: string, duplicates: number) =>
    duplicates === 0
      ? Effect.void
      : Effect.logWarning("a settings file names one secret host more than once; the last wins", {
          path,
          duplicates,
        });

  /** Read on every load like settings.json, and never written. */
  const loadSharedSettings = Effect.gen(function* () {
    if (sharedSettingsPath === undefined) return undefined;
    if (!(yield* fs.exists(sharedSettingsPath).pipe(Effect.orElseSucceed(() => false)))) {
      yield* Effect.logWarning("shared settings file not found, ignoring it", {
        path: sharedSettingsPath,
      });
      return { document: {}, baseline: DEFAULT_SERVER_SETTINGS, status: "missing" } as const;
    }
    const contents = yield* Effect.exit(fs.readFileString(sharedSettingsPath));
    if (Exit.isFailure(contents)) return yield* unusableSharedSettings(contents.cause);
    const parsed = decodeSettingsDocumentExit(contents.value);
    if (Exit.isFailure(parsed)) return yield* unusableSharedSettings(Cause.pretty(parsed.cause));
    // The fold marker records this machine's migration history, not a preference.
    const { projectSettingsFolded: _machineLocal, ...raw } = parsed.value;
    const { document, duplicates } = canonicalizeSecretFields(raw);
    yield* warnDuplicateSecretHosts(sharedSettingsPath, duplicates);
    const decoded = decodePersistedServerSettingsExit(document);
    if (Exit.isFailure(decoded)) return yield* unusableSharedSettings(Cause.pretty(decoded.cause));
    const baseline = yield* Effect.exit(normalizeServerSettings(decoded.value));
    if (Exit.isFailure(baseline)) return yield* unusableSharedSettings(baseline.cause);
    return { document, baseline: baseline.value, status: "loaded" } as const;
  });

  const loadSettingsFromDisk = Effect.gen(function* () {
    const shared = yield* loadSharedSettings;
    // Every patch stores `backgroundActivity` normalized. Over a shared layer the
    // loaded settings and the baseline must hold that same form, or each write
    // would persist the shared value's normalized copy.
    const normalizeBackgroundActivity = (settings: ServerSettings): ServerSettings =>
      shared === undefined
        ? settings
        : { ...settings, backgroundActivity: normalizeServerBackgroundActivitySettings(settings) };
    const baseline = normalizeBackgroundActivity(shared?.baseline ?? DEFAULT_SERVER_SETTINGS);
    const layer: SettingsLayer = {
      baseline,
      keepLocalKeys: shared !== undefined && shared.status !== "loaded",
    };
    let settings = baseline;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();
    let localInstanceIds: ReadonlySet<string> = new Set();
    let localSourceControlKinds: ReadonlySet<string> = new Set();

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const document = decodeSettingsDocumentExit(raw);
      const local =
        shared !== undefined && Exit.isSuccess(document)
          ? canonicalizeSecretFields(document.value)
          : undefined;
      if (local !== undefined) yield* warnDuplicateSecretHosts(settingsPath, local.duplicates);
      const decoded = Exit.isFailure(document)
        ? Exit.failCause(document.cause)
        : decodePersistedServerSettingsExit(
            shared === undefined || local === undefined
              ? document.value
              : layerSettingsDocuments(shared.document, local.document),
          );
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
        legacySourceControl = {
          bitbucket: legacySettings.value.bitbucket,
          github: legacySettings.value.github,
        };
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        settings = { ...baseline, continueThreadsAfterServerUpdate: false };
        if (failure._tag === "Failure") {
          parseFailure = Option.some(Cause.squash(failure.cause));
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = normalizeBackgroundActivity(decoded.value);
        if (Exit.isSuccess(document) && isSettingsDocument(document.value.providerInstances)) {
          localInstanceIds = new Set(Object.keys(document.value.providerInstances));
        }
        if (Exit.isSuccess(document) && isSettingsDocument(document.value.sourceControlHosts)) {
          localSourceControlKinds = new Set(Object.keys(document.value.sourceControlHosts));
        }
      }
    }

    // A file that failed to decode must stay on disk for the user to repair.
    const settingsFileTrusted = shared?.status !== "unusable" && Option.isNone(parseFailure);
    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      legacyProviders === undefined
        ? settings
        : migrateLegacyProviderSettings(
            settings,
            legacyProviders,
            providerHistory,
            localInstanceIds,
          ),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Copied, not moved: the old entry is removed only after the new file is written. A token
    // that cannot be read or copied leaves the retired keys in place, so the migration runs again
    // on the next load instead of dropping it.
    const unstoredLegacySecrets = new Set<string>();
    // Only a shared host can replace a placeholder, and a failed read may hide a stored value.
    const noteUnstoredPlaceholder = (move: { readonly from: string; readonly to: string }) =>
      shared === undefined
        ? Effect.void
        : secretStore.get(move.to).pipe(
            Effect.map((current) => {
              if (Option.isNone(current)) unstoredLegacySecrets.add(move.from);
            }),
            Effect.ignore,
          );
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl, localSourceControlKinds)
            .secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isSome(secret)
              ? secretStore.set(move.to, secret.value)
              : noteUnstoredPlaceholder(move),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(
          folded,
          legacySourceControl,
          localSourceControlKinds,
          unstoredLegacySecrets,
        )
      : { settings: folded, secretMoves: [], duplicates: 0 };
    yield* warnDuplicateSecretHosts(settingsPath, sourceControlMigration.duplicates);
    const {
      settings: migrated,
      sharedSecretLeftInline,
      rollbackSharedSecrets,
    } = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings, baseline)
      : { settings: folded, sharedSecretLeftInline: false, rollbackSharedSecrets: Effect.void };
    if (
      !sharedSecretLeftInline &&
      (migrated !== loaded ||
        (settingsFileTrusted && legacyProviders !== undefined) ||
        hasLegacySourceControl)
    ) {
      yield* writeSettingsAtomically(migrated, layer).pipe(
        Effect.tapError(() => rollbackSharedSecrets),
      );
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(Effect.ignore);
      }
    }
    return yield* settingsStateFor(layer, migrated, yield* loadManagedLayer, parseFailure);
  });

  const managedFileError = (cause: unknown) =>
    new ServerSettingsError({
      settingsPath: managedSettingsPath ?? settingsPath,
      operation: "read-managed-file",
      cause,
    });

  const resolveManagedFileReferences = (
    value: unknown,
  ): Effect.Effect<unknown, ServerSettingsError> => {
    if (Array.isArray(value)) {
      return Effect.forEach(value, resolveManagedFileReferences);
    }
    if (!isSettingsDocument(value)) {
      return Effect.succeed(value);
    }
    if (isFileReference(value)) {
      return fs.readFileString(value.$file).pipe(
        Effect.map((contents) => contents.replace(/\r?\n$/, "")),
        Effect.mapError(managedFileError),
      );
    }
    return Effect.forEach(Object.entries(value), ([key, entry]) =>
      resolveManagedFileReferences(entry).pipe(Effect.map((resolved) => [key, resolved] as const)),
    ).pipe(Effect.map(Object.fromEntries));
  };

  const ignoreManagedSetting = (
    setting: string,
    details: {
      readonly reason: string;
      readonly paths?: ReadonlyArray<string>;
      readonly cause?: unknown;
    },
  ) =>
    Effect.logWarning("ignoring a managed setting", {
      path: managedSettingsPath,
      setting,
      ...details,
    });

  const logManagedDefect = (
    message: string,
    defect: unknown,
    details: { readonly setting?: string } = {},
  ) =>
    Effect.logError(message, {
      path: managedSettingsPath,
      ...details,
      cause: Cause.pretty(Cause.die(defect)),
    });

  const loadManagedLayer = Effect.gen(function* () {
    if (managedSettingsPath === undefined) return undefined;
    const raw = yield* fs
      .readFileString(managedSettingsPath)
      .pipe(Effect.mapError(managedFileError));
    const decoded = decodeSettingsDocumentExit(raw);
    if (decoded._tag === "Failure") {
      return yield* managedFileError(decoded.cause);
    }
    // An inline credential voids the whole file rather than one entry: it is already exposed
    // wherever the file lives, and that should not go unnoticed behind the rest still applying.
    const inlineSecret = findInlineManagedSecret(decoded.value);
    if (inlineSecret !== undefined) {
      return yield* managedFileError(
        new Error(`${inlineSecret} must reference a file with {"$file": "/path"}`),
      );
    }
    let document: SettingsDocument = {};
    const fromFiles = new Set<string>();
    for (const entry of managedEntries(decoded.value)) {
      if (!Object.hasOwn(ServerSettings.fields, entry.key)) {
        yield* ignoreManagedSetting(entry.setting, { reason: "is not a known setting" });
        continue;
      }
      if (DERIVED_SETTINGS_KEYS.has(entry.key)) {
        yield* ignoreManagedSetting(entry.setting, {
          reason: "is derived from projectSettingsOverrides; manage that instead",
        });
        continue;
      }
      // Checked before any file is read.
      if (hasMisplacedFileReference(entry.document)) {
        yield* ignoreManagedSetting(entry.setting, {
          reason: "uses $file outside a credential; $file is only for credentials",
        });
        continue;
      }
      const canonical = yield* resolveManagedFileReferences(
        markReferencedEnvironmentSensitive(entry.document),
      ).pipe(
        Effect.map((resolved) =>
          canonicalizeSecretFields(dropRedactionFlags(resolved) as SettingsDocument),
        ),
        Effect.catch((error) =>
          ignoreManagedSetting(entry.setting, {
            reason: "references a file that cannot be read",
            cause: error.cause,
          }).pipe(Effect.as(undefined)),
        ),
        Effect.catchDefect((defect) =>
          logManagedDefect("loading a managed setting failed unexpectedly; ignoring it", defect, {
            setting: entry.setting,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (canonical === undefined) continue;
      if (hasFileReference(entry.document)) fromFiles.add(entry.setting);
      yield* warnDuplicateSecretHosts(managedSettingsPath, canonical.duplicates);
      document = layerSettingsDocuments(document, canonical.document);
    }
    return {
      document,
      paths: managedLeafPaths(document),
      fromFiles,
    } satisfies ManagedSettingsLayer;
  }).pipe(
    Effect.catch((error: ServerSettingsError) =>
      Effect.logWarning("ignoring managed settings file", {
        path: managedSettingsPath,
        cause: error.cause,
      }).pipe(Effect.as(undefined)),
    ),
    Effect.catchDefect((defect) =>
      logManagedDefect(
        "loading the managed settings file failed unexpectedly; ignoring it",
        defect,
      ).pipe(Effect.as(undefined)),
    ),
  );

  const applyManagedLayer = (
    settings: ServerSettings,
    managed: SettingsDocument,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    encodeServerSettings(settings).pipe(
      Effect.flatMap((encoded) => decodeServerSettings(layerSettingsDocuments(encoded, managed))),
      Effect.mapError(managedFileError),
      Effect.flatMap(normalizeServerSettings),
    );

  /**
   * Applies `managed`, also returning the managed paths the result does not keep as written:
   * missing, coerced to null, or holding a key decoding ignores. A key absent from the result
   * still counts when removing it changes the result, as when decoding migrates a legacy shape.
   */
  const enforceManagedLayer = Effect.fn("serverSettings.enforceManagedLayer")(function* (
    settings: ServerSettings,
    managed: SettingsDocument,
  ) {
    const encode = (value: ServerSettings) =>
      encodeServerSettings(value).pipe(Effect.mapError(managedFileError));
    const effective = yield* applyManagedLayer(settings, managed);
    const encoded = yield* encode(effective);
    const ignoresKey = (path: ReadonlyArray<string>) =>
      applyManagedLayer(settings, withoutSettingsKey(managed, path) as SettingsDocument).pipe(
        Effect.flatMap(encode),
        Effect.map((without) => Equal.equals(without, encoded)),
        Effect.catch(() => Effect.succeed(false)),
      );
    const dropped: string[] = [];
    for (const path of managedLeafPaths(managed)) {
      const value = readSettingsPath(managed, path);
      // Encoding omits some nulls, so the decoded form counts too.
      const kept = [readSettingsPath(encoded, path), readSettingsPath(effective, path)].filter(
        (candidate) => candidate !== undefined,
      );
      if (kept.length === 0 || (value !== null && kept.every((candidate) => candidate === null))) {
        dropped.push(path.join("."));
        continue;
      }
      const missing = kept
        .map((candidate) => missingKeyPaths(value, candidate, path))
        .reduce((fewest, next) => (next.length < fewest.length ? next : fewest));
      for (const keyPath of missing) {
        if (yield* ignoresKey(keyPath)) dropped.push(keyPath.join("."));
      }
    }
    return { effective, dropped };
  });

  const settingsStateFor = (
    layer: SettingsLayer,
    settings: ServerSettings,
    managed: ManagedSettingsLayer | undefined,
    parseFailure: Option.Option<unknown> = Option.none(),
  ): Effect.Effect<SettingsState> => {
    const { baseline, keepLocalKeys } = layer;
    const unmanaged: SettingsState = {
      parseFailure,
      baseline,
      keepLocalKeys,
      settings,
      effective: settings,
      managed: undefined,
    };
    if (managed === undefined) return Effect.succeed(unmanaged);
    return Effect.gen(function* () {
      const whole = yield* Effect.exit(enforceManagedLayer(settings, managed.document));
      if (Exit.isSuccess(whole) && whole.value.dropped.length === 0) {
        return { ...unmanaged, effective: whole.value.effective, managed };
      }
      // Drop only the entries not enforced as written, so the rest of the file still is.
      let document: SettingsDocument = {};
      for (const entry of managedEntries(managed.document)) {
        const rejection = yield* enforceManagedLayer(settings, entry.document).pipe(
          Effect.map(({ dropped }) =>
            dropped.length === 0
              ? undefined
              : {
                  reason: "is renamed, dropped, or coerced by the settings schema",
                  paths: dropped,
                },
          ),
          Effect.catch((error) =>
            Effect.succeed({
              reason: "does not fit the settings schema",
              ...(managed.fromFiles.has(entry.setting) ? {} : { cause: error.cause }),
            }),
          ),
          Effect.catchDefect((defect) =>
            logManagedDefect(
              "applying a managed setting failed unexpectedly; ignoring it",
              defect,
              {
                setting: entry.setting,
              },
            ).pipe(Effect.as(null)),
          ),
        );
        if (rejection === undefined) document = layerSettingsDocuments(document, entry.document);
        else if (rejection !== null) yield* ignoreManagedSetting(entry.setting, rejection);
      }
      const fitting: ManagedSettingsLayer = {
        document,
        paths: managedLeafPaths(document),
        fromFiles: managed.fromFiles,
      };
      return yield* applyManagedLayer(settings, document).pipe(
        Effect.map((effective): SettingsState => ({ ...unmanaged, effective, managed: fitting })),
        Effect.catch((error) =>
          Effect.logWarning("ignoring managed settings that do not fit the settings schema", {
            path: managedSettingsPath,
            ...(managed.fromFiles.size > 0 ? {} : { cause: error.cause }),
          }).pipe(Effect.as(unmanaged)),
        ),
      );
    }).pipe(
      // Keeping `managed` leaves writes to its paths rejected while its values are not applied.
      Effect.catchDefect((defect) =>
        logManagedDefect("applying managed settings failed unexpectedly", defect).pipe(
          Effect.as({ ...unmanaged, managed }),
        ),
      ),
    );
  };

  const settingsBeneathManaged = (
    current: SettingsState,
    updated: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError | ManagedSettingWriteError> => {
    const managed = current.managed;
    if (managed === undefined) return Effect.succeed(updated);
    return Effect.gen(function* () {
      const before = yield* encodeServerSettings(redactServerSettingsForClient(current.effective));
      const after = yield* encodeServerSettings(redactServerSettingsForClient(updated));
      const changed = managed.paths.find(
        (path) => !Equal.equals(readSettingsPath(after, path), readSettingsPath(before, path)),
      );
      if (changed !== undefined) {
        return yield* new ManagedSettingWriteError({ setting: changed.join(".") });
      }
      const restored = restoreUnmanagedSettings(
        yield* encodeServerSettings(updated),
        yield* encodeServerSettings(current.settings),
        managed.document,
      );
      return yield* decodeServerSettings(restored);
    }).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(new ServerSettingsError({ settingsPath, operation: "normalize", cause })),
      }),
    );
  };

  const settingsCache = yield* Cache.makeWith<typeof cacheKey, SettingsState, ServerSettingsError>(
    () => loadSettingsFromDisk,
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.effective),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const getStateFromCache = Cache.get(settingsCache, cacheKey);

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = Effect.fn("serverSettings.persistSettingsSecrets")(function* (
    current: ServerSettings,
    next: ServerSettings,
    baseline: ServerSettings,
  ) {
    const previous = new Map<string, SettingsSecret>();
    mapSettingsSecrets(current, (secret) => {
      previous.set(secret.secretName, secret);
      return secret;
    });
    const inlineValueOf = (secretName: string) => {
      const old = previous.get(secretName);
      return old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
    };
    // What each redacted secret holds: its previous inline value, or the stored one where
    // the shared file supplies that secret, so an entry reverted to shared matches it again.
    const sharedSecretNames = new Set<string>();
    mapSettingsSecrets(baseline, (secret) => {
      if (secret.sensitive && !secret.redacted && secret.value.length > 0) {
        sharedSecretNames.add(secret.secretName);
      }
      return secret;
    });
    const resolvable: SettingsSecret[] = [];
    mapSettingsSecrets(next, (secret) => {
      if (secret.sensitive && secret.redacted) resolvable.push(secret);
      return secret;
    });
    const resolvedValues = new Map<string, string>();
    for (const secret of resolvable) {
      const inline = inlineValueOf(secret.secretName);
      if (inline !== undefined) {
        resolvedValues.set(secret.secretName, inline);
        continue;
      }
      if (!sharedSecretNames.has(secret.secretName)) continue;
      const stored = yield* secretStore.get(secret.secretName).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              providerInstanceId: secret.providerInstanceId,
              environmentVariable: secret.environmentVariable,
              cause,
            }),
        ),
      );
      if (Option.isSome(stored)) {
        resolvedValues.set(secret.secretName, textDecoder.decode(stored.value));
      }
    }
    const inherited = inheritedSecretValues(next, baseline, resolvedValues);
    const changes: SecretChange[] = [];
    const nextSecretNames = new Set<string>();
    const settings = mapSettingsSecrets(next, (secret) => {
      const metadata = {
        secretName: secret.secretName,
        ...(secret.providerInstanceId !== undefined
          ? { providerInstanceId: secret.providerInstanceId }
          : {}),
        ...(secret.environmentVariable !== undefined
          ? { environmentVariable: secret.environmentVariable }
          : {}),
      };
      if (!secret.sensitive) {
        changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
        return { value: secret.value, redacted: false };
      }
      const resolved = resolvedValues.get(secret.secretName);
      const value = !secret.redacted
        ? secret.value
        : (inlineValueOf(secret.secretName) ??
          (inherited.get(secret.secretName) === resolved ? resolved : undefined));
      if (value === undefined) {
        nextSecretNames.add(secret.secretName);
        return { value: "", redacted: true };
      }
      // Left inline so the write sees it unchanged from the shared file and omits it.
      if (inherited.get(secret.secretName) === value) return { value, redacted: false };
      if (value.length === 0) {
        changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
        return { value: "", redacted: false };
      }
      nextSecretNames.add(secret.secretName);
      changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
      return { value: "", redacted: true };
    });
    for (const secret of previous.values()) {
      if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
      if (changes.some((change) => change.secretName === secret.secretName)) continue;
      changes.push({
        kind: "remove",
        secretName: secret.secretName,
        operation: "remove-stale-secret",
        ...(secret.providerInstanceId !== undefined
          ? { providerInstanceId: secret.providerInstanceId }
          : {}),
        ...(secret.environmentVariable !== undefined
          ? { environmentVariable: secret.environmentVariable }
          : {}),
      });
    }
    return { settings, changes };
  });

  const rollbackSettingsSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateAndPersistSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError | ManagedSettingWriteError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* reloadSettings;
        const { settings: current, parseFailure } = state;
        if (Option.isSome(parseFailure)) {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        }
        const updated = yield* settingsBeneathManaged(state, yield* update(state.effective));
        const persisted = yield* persistSettingsSecrets(current, updated, state.baseline);
        const next = yield* normalizeServerSettings(persisted.settings);
        const nextState = yield* settingsStateFor(state, next, state.managed);
        const materialized = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
            const materializedExit = yield* Effect.exit(
              materializeSettingsSecrets(nextState.effective),
            );
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next, state));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }),
        );
        yield* Cache.set(settingsCache, cacheKey, nextState);
        yield* emitChange(nextState.effective);
        return resolveTextGenerationProvider(materialized);
      }),
    );

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap(materializeSettingsSecrets),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { effective } = yield* reloadSettings;
      yield* emitChange(effective);
    }),
  );

  const watchFileChanges = (filePath: string) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    return fs
      .watch(directory)
      .pipe(
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === filePath ||
            pathService.resolve(directory, event.path) === resolvedFilePath,
        ),
      );
  };

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // A symlinked settings file is rewritten in its destination's directory,
    // which a watch on the link's directory never sees. The link is resolved
    // again whenever it changes, so repointing it moves the watch along.
    const watchSettingsFile = Effect.fnUntraced(function* (
      filePath: string,
      options: { readonly prepareLinkTargetDirectory: boolean },
    ) {
      const watchLinkTarget = Effect.gen(function* () {
        const linkTargetPath = yield* resolveSymlinkTarget(filePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
        );
        if (linkTargetPath === pathService.resolve(filePath)) {
          return Option.none<string>();
        }
        if (options.prepareLinkTargetDirectory) {
          yield* fs
            .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
            .pipe(Effect.ignore({ log: true }));
        }
        return Option.some(linkTargetPath);
      }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

      const initialLinkTarget = yield* watchLinkTarget;
      const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
        Stream.concat(watchFileChanges(filePath).pipe(Stream.mapEffect(() => watchLinkTarget))),
        Stream.changes,
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (linkTargetPath) =>
              watchFileChanges(linkTargetPath).pipe(Stream.ignore({ log: true })),
          }),
        ),
      );
      return Stream.merge(watchFileChanges(filePath), linkTargetEvents);
    });

    const settingsEvents = yield* watchSettingsFile(settingsPath, {
      prepareLinkTargetDirectory: true,
    });
    // Nothing is created for the read-only shared file, and a watch that fails
    // there must not take the settings.json watch down with it.
    const sharedSettingsEvents =
      sharedSettingsPath === undefined
        ? Stream.empty
        : (yield* watchSettingsFile(sharedSettingsPath, {
            prepareLinkTargetDirectory: false,
          })).pipe(Stream.ignore({ log: true }));

    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = Stream.merge(settingsEvents, sharedSettingsEvents).pipe(
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadSettings;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSettingsSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    managedSettingPaths: getStateFromCache.pipe(Effect.map((state) => state.managed?.paths ?? [])),
    updateSettings: (patch) =>
      updateAndPersistSettings((current) =>
        Effect.succeed(applyServerSettingsPatch(current, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings((current) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
          const patched = applyServerSettingsPatch(current, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    withSettingsSnapshot,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
