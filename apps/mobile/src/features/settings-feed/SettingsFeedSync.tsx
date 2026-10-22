import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import {
  type ManageablePreferenceKey,
  managedPreferenceKeys,
} from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { fetchSettingsFeed, nextSettingsFeedState } from "./settingsFeed";

const FOREGROUND_REFRESH_INTERVAL_MS = 10 * 60_000;

export function useRefreshSettingsFeed() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    async (url: string) => {
      const result = await fetchSettingsFeed(url);
      const now = Date.now();
      savePreferences({
        transform: (current) =>
          current.settingsFeed?.url === url
            ? { settingsFeed: nextSettingsFeedState(current.settingsFeed, result, now) }
            : {},
      });
    },
    [savePreferences],
  );
}

/** Keys the settings feed currently controls; their rows are read-only. */
export function useManagedPreferenceKeys(): ReadonlySet<ManageablePreferenceKey> {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? managedPreferenceKeys(preferences.value)
    : new Set<ManageablePreferenceKey>();
}

/** Refreshes the feed at launch and when the app returns after a while away. */
export function SettingsFeedSync() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const refresh = useRefreshSettingsFeed();
  const feed = AsyncResult.isSuccess(preferences) ? preferences.value.settingsFeed : undefined;
  const url = feed?.url;
  const lastAttempt = useRef(0);

  useEffect(() => {
    if (url === undefined) return;
    const maybeRefresh = () => {
      const now = Date.now();
      if (now - lastAttempt.current < FOREGROUND_REFRESH_INTERVAL_MS) return;
      lastAttempt.current = now;
      void refresh(url);
    };
    maybeRefresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") maybeRefresh();
    });
    return () => subscription.remove();
  }, [refresh, url]);

  return null;
}
