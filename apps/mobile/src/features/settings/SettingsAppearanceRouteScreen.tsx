import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { ManagedBySettingsFeedNote } from "../settings-feed/ManagedBySettingsFeedNote";
import { useManagedPreferenceKeys } from "../settings-feed/SettingsFeedSync";

const APPEARANCE_KEYS = [
  "themeId",
  "lightThemeId",
  "darkThemeId",
  "themeMode",
  "baseFontSize",
  "terminalFontSize",
  "markdownFontSize",
  "codeFontSize",
  "codeWordBreak",
] as const;

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();
  const managedKeys = useManagedPreferenceKeys();
  const managed = APPEARANCE_KEYS.some((key) => managedKeys.has(key));

  return (
    <SettingsScreen title="Appearance">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {managed ? <ManagedBySettingsFeedNote /> : null}
        <ThemeAppearanceSection />
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
