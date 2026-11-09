import type { CoordinatorChoice } from "@t3tools/client-runtime/state/coordinator-inbox";
import type { DefaultCoordinatorRef } from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useCoordinatorChoices } from "../../state/coordinators";
import { useEnvironmentIdentities } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTOMATIC = "automatic";

const refKey = (ref: DefaultCoordinatorRef) => `${ref.environmentId}\n${ref.coordinatorId}`;
const choiceKey = (choice: CoordinatorChoice) =>
  refKey({ environmentId: choice.environmentId, coordinatorId: choice.coordinator.id });

export function DefaultCoordinatorSetting() {
  const choices = useCoordinatorChoices();
  const chosen = useClientSettings((settings) => settings.defaultCoordinator);
  const identities = useEnvironmentIdentities();
  if (choices.length === 0 && chosen === null) return null;

  const labelFor = (choice: CoordinatorChoice) => {
    const environment = identities.find((entry) => entry.environmentId === choice.environmentId);
    return `${choice.coordinator.name} · ${environment?.label ?? choice.environmentId}`;
  };
  const value = chosen === null ? AUTOMATIC : refKey(chosen);
  const selected = choices.find((choice) => choiceKey(choice) === value);

  return (
    <SettingsRow
      {...searchableSetting("default-coordinator")}
      description="The coordinator whose inbox the sidebar shows and that Open coordinator opens. Automatic picks the only one."
      resetAction={
        chosen !== null ? (
          <SettingResetButton
            label="coordinator"
            onClick={() => void updateClientSettings({ defaultCoordinator: null })}
          />
        ) : null
      }
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            if (next === AUTOMATIC) {
              void updateClientSettings({ defaultCoordinator: null });
              return;
            }
            const choice = choices.find((entry) => choiceKey(entry) === next);
            if (choice === undefined) return;
            void updateClientSettings({
              defaultCoordinator: {
                environmentId: choice.environmentId,
                coordinatorId: choice.coordinator.id,
              },
            });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Coordinator">
            <SelectValue>
              {value === AUTOMATIC
                ? "Automatic"
                : selected
                  ? labelFor(selected)
                  : "Unavailable coordinator"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={AUTOMATIC}>
              Automatic
            </SelectItem>
            {choices.map((choice) => (
              <SelectItem hideIndicator key={choiceKey(choice)} value={choiceKey(choice)}>
                {labelFor(choice)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
