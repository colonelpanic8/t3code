import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { subscribeAppActive } from "../../lib/appState";
import {
  type ManageablePreferenceKey,
  managedPreferenceKeys,
} from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { fetchSettingsFeed, nextSettingsFeedState } from "./settingsFeed";

const FOREGROUND_REFRESH_INTERVAL_MS = 10 * 60_000;

export async function refreshSettingsFeed(url: string): Promise<void> {
  const result = await fetchSettingsFeed(url);
  const now = Date.now();
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    transform: (current) =>
      current.settingsFeed?.url === url
        ? { settingsFeed: nextSettingsFeedState(current.settingsFeed, result, now) }
        : {},
  });
}

/** Keys the settings feed currently controls; their rows are read-only. */
export function useManagedPreferenceKeys(): ReadonlySet<ManageablePreferenceKey> {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? managedPreferenceKeys(preferences.value)
    : new Set<ManageablePreferenceKey>();
}

/** Refreshes the feed at launch and when the app returns after a while away. */
export function installSettingsFeedSync(): () => void {
  let url: string | undefined;
  let lastAttempt = 0;
  const maybeRefresh = () => {
    if (url === undefined) return;
    const now = Date.now();
    if (now - lastAttempt < FOREGROUND_REFRESH_INTERVAL_MS) return;
    lastAttempt = now;
    void refreshSettingsFeed(url);
  };
  const unsubscribePreferences = appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (preferences) => {
      const next = AsyncResult.isSuccess(preferences)
        ? preferences.value.settingsFeed?.url
        : undefined;
      if (next === url) return;
      url = next;
      maybeRefresh();
    },
    { immediate: true },
  );
  const unsubscribeAppActive = subscribeAppActive(maybeRefresh);
  return () => {
    unsubscribePreferences();
    unsubscribeAppActive();
  };
}
