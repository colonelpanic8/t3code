import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  EnvironmentId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  type ProviderInstanceId,
  type PullRequestMergeMethod,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { ComposerEnterBehavior } from "../lib/composerEnterBehavior";
import type { FollowUpBehavior } from "../lib/followUpBehavior";
import { isMicrophoneKind, type MicrophoneEntry } from "../lib/microphonePriority";
import { MOBILE_THEME_IDS, type MobileThemeId, type MobileThemeMode } from "../lib/mobileTheme";
import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";

const PREFERENCES_KEY = "t3code.preferences";
const PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

export const PullRequestListControls = Schema.Struct({
  state: PullRequestListState,
  involvement: PullRequestInvolvement,
  filters: PullRequestListFilters,
  projectId: Schema.optional(Schema.String),
  projectEnvironmentId: Schema.optional(Schema.String),
  sort: Schema.Literals(["updated", "created", "oldest"]),
});
export type PullRequestListControls = typeof PullRequestListControls.Type;

const ThreadListFilters = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  projectKey: Schema.NullOr(Schema.String),
});
export type ThreadListFilters = typeof ThreadListFilters.Type;

const PullRequestListPreferences = Schema.Struct({
  environmentId: Schema.NullOr(Schema.String),
  controls: Schema.Record(Schema.String, PullRequestListControls),
});
export type PullRequestListPreferences = typeof PullRequestListPreferences.Type;

const isThreadListFilters = Schema.is(ThreadListFilters);
const isPullRequestListPreferences = Schema.is(PullRequestListPreferences);

/** Preferences a settings feed may set. Device-local state never comes from a feed. */
export const MANAGEABLE_PREFERENCE_KEYS = [
  "pullRequestHideTestFiles",
  "pullRequestMergeMethod",
  "liveActivitiesEnabled",
  "themeId",
  "lightThemeId",
  "darkThemeId",
  "themeMode",
  "baseFontSize",
  "terminalFontSize",
  "markdownFontSize",
  "codeFontSize",
  "codeWordBreak",
  "composerEnterBehavior",
  "followUpBehavior",
  "projectGroupingEnabled",
  "projectGroupingMode",
  "planModeEnabled",
  "workingShelfEnabled",
  "modelFavorites",
] as const satisfies ReadonlyArray<keyof Preferences>;
export type ManageablePreferenceKey = (typeof MANAGEABLE_PREFERENCE_KEYS)[number];
export type ManagedPreferences = Partial<Pick<Preferences, ManageablePreferenceKey>>;

export interface SettingsFeedState {
  readonly url: string;
  readonly managed?: ManagedPreferences;
  readonly fetchedAt?: number;
  readonly error?: string;
}

export interface Preferences {
  readonly pullRequestHideTestFiles?: boolean;
  readonly pullRequestMergeMethod?: PullRequestMergeMethod;
  readonly liveActivitiesEnabled?: boolean;
  readonly themeId?: MobileThemeId;
  readonly lightThemeId?: MobileThemeId;
  readonly darkThemeId?: MobileThemeId;
  readonly themeMode?: MobileThemeMode;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
  /** Environments whose "reclaim database space" notice was dismissed. */
  readonly dismissedDatabaseStorageNotices?: readonly string[];
  /** What the Return key does in the composer on a hardware keyboard. iOS only. */
  readonly composerEnterBehavior?: ComposerEnterBehavior;
  readonly followUpBehavior?: FollowUpBehavior;
  readonly microphones?: ReadonlyArray<MicrophoneEntry>;
  readonly projectGroupingEnabled?: boolean;
  readonly projectGroupingMode?: SidebarProjectGroupingMode;
  readonly planModeEnabled?: boolean;
  readonly workingShelfEnabled?: boolean;
  readonly modelFavorites?: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
  readonly threadListSettledShelfExpanded?: boolean;
  readonly threadListSnoozedShelfExpanded?: boolean;
  readonly threadListWorkingShelfExpanded?: boolean;
  readonly threadListFilters?: ThreadListFilters;
  readonly pullRequestListFilters?: PullRequestListPreferences;
  readonly settingsFeed?: SettingsFeedState;
}

export class MobilePreferencesLoadError extends Schema.TaggedError<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedError<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: Preferences;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/persistence/MobilePreferencesStore") {}

function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    pullRequestHideTestFiles?: boolean;
    pullRequestMergeMethod?: PullRequestMergeMethod;
    liveActivitiesEnabled?: boolean;
    themeId?: MobileThemeId;
    lightThemeId?: MobileThemeId;
    darkThemeId?: MobileThemeId;
    themeMode?: MobileThemeMode;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
    dismissedDatabaseStorageNotices?: readonly string[];
    composerEnterBehavior?: ComposerEnterBehavior;
    followUpBehavior?: FollowUpBehavior;
    microphones?: ReadonlyArray<MicrophoneEntry>;
    projectGroupingEnabled?: boolean;
    projectGroupingMode?: SidebarProjectGroupingMode;
    planModeEnabled?: boolean;
    workingShelfEnabled?: boolean;
    modelFavorites?: Preferences["modelFavorites"];
    threadListSettledShelfExpanded?: boolean;
    threadListSnoozedShelfExpanded?: boolean;
    threadListWorkingShelfExpanded?: boolean;
    threadListFilters?: ThreadListFilters;
    pullRequestListFilters?: PullRequestListPreferences;
    settingsFeed?: SettingsFeedState;
  } = {};

  if (typeof parsed.pullRequestHideTestFiles === "boolean") {
    preferences.pullRequestHideTestFiles = parsed.pullRequestHideTestFiles;
  }

  if (
    parsed.pullRequestMergeMethod === "squash" ||
    parsed.pullRequestMergeMethod === "merge" ||
    parsed.pullRequestMergeMethod === "rebase"
  ) {
    preferences.pullRequestMergeMethod = parsed.pullRequestMergeMethod;
  }

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (
    typeof parsed.themeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.themeId)
  ) {
    preferences.themeId = parsed.themeId as MobileThemeId;
  }
  if (
    typeof parsed.lightThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.lightThemeId)
  ) {
    preferences.lightThemeId = parsed.lightThemeId as MobileThemeId;
  }
  if (
    typeof parsed.darkThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.darkThemeId)
  ) {
    preferences.darkThemeId = parsed.darkThemeId as MobileThemeId;
  }
  if (
    parsed.themeMode === "system" ||
    parsed.themeMode === "light" ||
    parsed.themeMode === "dark"
  ) {
    preferences.themeMode = parsed.themeMode;
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (Array.isArray(parsed.dismissedDatabaseStorageNotices)) {
    preferences.dismissedDatabaseStorageNotices = parsed.dismissedDatabaseStorageNotices.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (parsed.composerEnterBehavior === "send" || parsed.composerEnterBehavior === "newline") {
    preferences.composerEnterBehavior = parsed.composerEnterBehavior;
  }
  if (parsed.followUpBehavior === "queue" || parsed.followUpBehavior === "steer") {
    preferences.followUpBehavior = parsed.followUpBehavior;
  }
  if (Array.isArray(parsed.microphones)) {
    preferences.microphones = parsed.microphones.flatMap((entry): MicrophoneEntry[] => {
      if (typeof entry !== "object" || entry === null || !isMicrophoneKind(entry.kind)) return [];
      if (!("uid" in entry)) return [{ kind: entry.kind }];
      return typeof entry.uid === "string" && typeof entry.name === "string"
        ? [{ kind: entry.kind, uid: entry.uid, name: entry.name }]
        : [];
    });
  }
  if (typeof parsed.projectGroupingEnabled === "boolean") {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }
  if (
    parsed.projectGroupingMode === "repository" ||
    parsed.projectGroupingMode === "repository_path" ||
    parsed.projectGroupingMode === "separate"
  ) {
    preferences.projectGroupingMode = parsed.projectGroupingMode;
  }
  if (typeof parsed.planModeEnabled === "boolean") {
    preferences.planModeEnabled = parsed.planModeEnabled;
  }
  if (typeof parsed.workingShelfEnabled === "boolean") {
    preferences.workingShelfEnabled = parsed.workingShelfEnabled;
  }
  if (Array.isArray(parsed.modelFavorites)) {
    preferences.modelFavorites = parsed.modelFavorites.filter(
      (favorite) =>
        typeof favorite === "object" &&
        favorite !== null &&
        typeof favorite.provider === "string" &&
        favorite.provider.length > 0 &&
        typeof favorite.model === "string" &&
        favorite.model.trim().length > 0,
    );
  }
  if (typeof parsed.threadListSettledShelfExpanded === "boolean") {
    preferences.threadListSettledShelfExpanded = parsed.threadListSettledShelfExpanded;
  }
  if (typeof parsed.threadListSnoozedShelfExpanded === "boolean") {
    preferences.threadListSnoozedShelfExpanded = parsed.threadListSnoozedShelfExpanded;
  }
  if (typeof parsed.threadListWorkingShelfExpanded === "boolean") {
    preferences.threadListWorkingShelfExpanded = parsed.threadListWorkingShelfExpanded;
  }
  if (isThreadListFilters(parsed.threadListFilters)) {
    preferences.threadListFilters = parsed.threadListFilters;
  }
  if (isPullRequestListPreferences(parsed.pullRequestListFilters)) {
    preferences.pullRequestListFilters = parsed.pullRequestListFilters;
  }
  const feed: unknown = parsed.settingsFeed;
  if (
    typeof feed === "object" &&
    feed !== null &&
    "url" in feed &&
    typeof feed.url === "string" &&
    feed.url.length > 0
  ) {
    preferences.settingsFeed = {
      url: feed.url,
      ...("managed" in feed && typeof feed.managed === "object" && feed.managed !== null
        ? { managed: sanitizeManagedPreferences(feed.managed as Preferences) }
        : {}),
      ...("fetchedAt" in feed && typeof feed.fetchedAt === "number"
        ? { fetchedAt: feed.fetchedAt }
        : {}),
      ...("error" in feed && typeof feed.error === "string" ? { error: feed.error } : {}),
    };
  }
  return preferences;
}

export function sanitizeManagedPreferences(parsed: Preferences): ManagedPreferences {
  const sanitized = sanitizePreferences(parsed);
  const managed: Record<string, unknown> = {};
  for (const key of MANAGEABLE_PREFERENCE_KEYS) {
    if (sanitized[key] !== undefined) managed[key] = sanitized[key];
  }
  return managed as ManagedPreferences;
}

export function managedPreferenceKeys(
  preferences: Preferences,
): ReadonlySet<ManageablePreferenceKey> {
  return new Set(Object.keys(preferences.settingsFeed?.managed ?? {}) as ManageablePreferenceKey[]);
}

/** Feed values win over the user's own; the user's stay stored underneath. */
export function applyManagedPreferences(preferences: Preferences): Preferences {
  const managed = preferences.settingsFeed?.managed;
  return managed === undefined ? preferences : { ...preferences, ...managed };
}

function withoutManagedKeys(
  patch: Partial<Preferences>,
  managed: ReadonlySet<ManageablePreferenceKey>,
): Partial<Preferences> {
  if (managed.size === 0) return patch;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!managed.has(key as ManageablePreferenceKey)) kept[key] = value;
  }
  return kept as Partial<Preferences>;
}

export const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null): Preferences | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );
      return null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("payload" in parsed) ||
      typeof parsed.payload !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    const preferences = parsePayload(parsed.payload);
    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: unknown,
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);
    return [next, next] as const;
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, { payload, updatedAt: timestamp });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);
      return;
    }
    yield* secureStorage
      .removeItem(PREFERENCES_FALLBACK_KEY)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove the mobile preferences fallback.").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );
  });

  const loadUnlocked = Effect.gen(function* () {
    const databaseResult = yield* Effect.result(database.loadPreferencesJson);
    const databaseAvailable = databaseResult._tag === "Success";
    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    const fallbackResult = yield* Effect.result(secureStorage.getItem(PREFERENCES_FALLBACK_KEY));
    let fallbackJson: string | null = null;
    if (fallbackResult._tag === "Success") {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);
    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;
    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: Preferences | null = null;
    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));
      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));
      if (fallbackJson !== null) {
        yield* secureStorage
          .removeItem(PREFERENCES_FALLBACK_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove a stale mobile preferences fallback.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage.getItem(PREFERENCES_KEY);
      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;
      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(Effect.map(loadUnlocked, applyManagedPreferences))
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;
          const patch = yield* Effect.try({
            try: () => transform(applyManagedPreferences(current)),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });
          const next: Preferences = {
            ...current,
            ...withoutManagedKeys(patch, managedPreferenceKeys(current)),
          };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);
          return applyManagedPreferences(next);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());
