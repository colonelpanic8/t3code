import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { coordinatorsAvailableAtom, useCoordinatorChoices } from "../../state/coordinators";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsSection } from "../settings/components/SettingsSection";

export function DefaultCoordinatorSettingsSection() {
  return useAtomValue(coordinatorsAvailableAtom) ? <DefaultCoordinatorChoices /> : null;
}

function DefaultCoordinatorChoices() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const environments = useWorkspaceEnvironments();
  const { choices, chosen, resolved } = useCoordinatorChoices();
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const automaticDetail =
    chosen === null && resolved
      ? `Uses ${resolved.coordinator.name}, the only coordinator.`
      : "Uses the only coordinator. With several, the Inbox asks.";
  return (
    <SettingsSection title="Coordinator" footer="The coordinator whose inbox this device shows.">
      <SettingsChoiceRow
        label="Automatic"
        description={automaticDetail}
        selected={chosen === null}
        disabled={!preferencesReady}
        onPress={() => savePreferences({ defaultCoordinator: null })}
      />
      {choices.map((choice) => {
        const environmentLabel =
          environments.find((environment) => environment.environmentId === choice.environmentId)
            ?.environmentLabel ?? choice.environmentId;
        return (
          <SettingsChoiceRow
            key={`${choice.environmentId}:${choice.coordinator.id}`}
            label={`${choice.coordinator.name} · ${environmentLabel}`}
            selected={
              chosen?.environmentId === choice.environmentId &&
              chosen.coordinatorId === choice.coordinator.id
            }
            separated
            disabled={!preferencesReady}
            onPress={() =>
              savePreferences({
                defaultCoordinator: {
                  environmentId: choice.environmentId,
                  coordinatorId: choice.coordinator.id,
                },
              })
            }
          />
        );
      })}
    </SettingsSection>
  );
}
