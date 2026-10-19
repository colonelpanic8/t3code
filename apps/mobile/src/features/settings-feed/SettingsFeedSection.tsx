import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Result from "effect/Result";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import type { ManageablePreferenceKey } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { RequestActionButton } from "../threads/RequestActionButton";
import { parseSettingsFeedUrl } from "./settingsFeed";
import { useManagedPreferenceKeys, useRefreshSettingsFeed } from "./SettingsFeedSync";

const KEY_LABELS: Record<ManageablePreferenceKey, string> = {
  pullRequestHideTestFiles: "Hide test files in pull requests",
  pullRequestMergeMethod: "Merge method",
  liveActivitiesEnabled: "Live Activities",
  themeId: "Theme",
  lightThemeId: "Light theme",
  darkThemeId: "Dark theme",
  themeMode: "Appearance",
  baseFontSize: "Text size",
  terminalFontSize: "Terminal text size",
  markdownFontSize: "Message text size",
  codeFontSize: "Code text size",
  codeWordBreak: "Wrap code",
  composerEnterBehavior: "Return key",
  followUpBehavior: "Follow-ups",
  projectGroupingEnabled: "Project grouping",
  projectGroupingMode: "Project grouping mode",
  planModeEnabled: "Plan mode",
  workingShelfEnabled: "Working shelf",
  modelFavorites: "Favorite models",
};

function formatAge(fetchedAt: number): string {
  const minutes = Math.round((Date.now() - fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** Tracks a settings file kept outside the app, such as one generated from dotfiles. */
export function SettingsFeedSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const refresh = useRefreshSettingsFeed();
  const managedKeys = useManagedPreferenceKeys();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  if (!AsyncResult.isSuccess(preferences)) return null;
  const feed = preferences.value.settingsFeed;

  const runRefresh = async (url: string) => {
    setRefreshing(true);
    await refresh(url);
    setRefreshing(false);
  };

  const track = () => {
    const parsed = parseSettingsFeedUrl(draft);
    if (Result.isFailure(parsed)) {
      setError(parsed.failure);
      return;
    }
    setError(null);
    setDraft("");
    savePreferences({ settingsFeed: { url: parsed.success } });
    void runRefresh(parsed.success);
  };

  const confirmStop = () =>
    Dialog.confirm({
      title: "Stop tracking settings?",
      message: "Settings it controlled go back to the values you chose on this device.",
      confirmText: "Stop tracking",
      destructive: true,
      onConfirm: () => savePreferences({ settingsFeed: undefined }),
    });

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Settings feed">
        {feed === undefined ? (
          <View className="gap-3 p-4">
            <TextInput
              accessibilityLabel="Settings feed address"
              placeholder="https://…/settings.age"
              value={draft}
              onChangeText={(value) => {
                setDraft(value);
                setError(null);
              }}
              autoCorrect={false}
              autoCapitalize="none"
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={track}
            />
            {error !== null ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <RequestActionButton
              label="Track settings"
              disabled={draft.trim().length === 0}
              onPress={track}
            />
          </View>
        ) : (
          <>
            <View className="gap-1 p-4">
              <Text
                selectable
                className="font-mono text-xs text-foreground-muted"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {feed.url}
              </Text>
              <Text className="text-sm text-foreground">
                {feed.fetchedAt === undefined
                  ? "Not loaded yet"
                  : `Updated ${formatAge(feed.fetchedAt)}`}
              </Text>
              {feed.error !== undefined ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {feed.error}
                </Text>
              ) : null}
              {managedKeys.size > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Controls: {[...managedKeys].map((key) => KEY_LABELS[key]).join(", ")}
                </Text>
              ) : null}
            </View>
            <View className="ml-4 border-t border-border-subtle" />
            <Pressable
              accessibilityRole="button"
              disabled={refreshing}
              onPress={() => void runRefresh(feed.url)}
              className="p-4 active:opacity-70"
            >
              <Text className="text-base text-foreground">
                {refreshing ? "Refreshing…" : "Refresh now"}
              </Text>
            </Pressable>
            <View className="ml-4 border-t border-border-subtle" />
            <Pressable
              accessibilityRole="button"
              onPress={confirmStop}
              className="p-4 active:opacity-70"
            >
              <Text className="text-base text-danger-foreground">Stop tracking</Text>
            </Pressable>
          </>
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Settings this file sets are read-only here and follow the file. An encrypted file opens with
        the fleet enrollment key.
      </Text>
    </View>
  );
}
