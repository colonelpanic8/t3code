import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

export function EnvironmentGroupsSettings() {
  const state = useAtomValue(environmentCatalog.groups.stateAtom);
  const setVisible = useAtomCommand(environmentCatalog.groups.setVisible);
  const reset = useAtomCommand(environmentCatalog.groups.resetVisibility);
  const importDocument = useAtomCommand(environmentCatalog.groups.importDocument);
  const refresh = useAtomRefresh(environmentCatalog.groups.definitionsAtom);
  const [importing, setImporting] = useState(false);

  const importGroups = async () => {
    setImporting(true);
    try {
      const { getDocumentAsync } = await import("expo-document-picker");
      const { File } = await import("expo-file-system");
      const result = await getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      if (!file) return;
      const imported = await importDocument(await new File(file.uri).text());
      if (imported._tag === "Failure") {
        const error = squashAtomCommandFailure(imported);
        Dialog.alert(
          "Could not import groups",
          error instanceof Error ? error.message : String(error),
        );
      }
    } catch (error) {
      Dialog.alert(
        "Could not import groups",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <View className="mb-5">
      <SettingsSection
        title="Environment groups"
        footer="Visibility lasts until the app restarts. Hidden environments stay connected and their work keeps running."
      >
        {state.failed ? (
          <SettingsRow icon="arrow.clockwise" label="Retry loading groups" onPress={refresh} />
        ) : null}
        {Object.entries(state.groups).map(([id, group]) => (
          <SettingsSwitchRow
            key={id}
            label={`Show ${group.label}`}
            subtitle={`${group.environmentIds.length} environments · ${group.defaultVisible ? "Visible" : "Hidden"} by default`}
            value={state.overrides.get(id) ?? group.defaultVisible}
            onValueChange={(visible) => void setVisible({ groupId: id, visible })}
          />
        ))}
        <SettingsRow
          icon="arrow.clockwise"
          label="Reset visibility"
          disabled={state.overrides.size === 0}
          onPress={() => void reset()}
        />
        <SettingsRow
          icon="folder"
          label="Import groups"
          disabled={importing}
          onPress={() => void importGroups()}
        />
      </SettingsSection>
    </View>
  );
}
