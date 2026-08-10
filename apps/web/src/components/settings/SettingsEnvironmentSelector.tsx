import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { useMemo } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { environmentAccentStyle, useEnvironmentAccentColors } from "../../environmentAccentColors";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface SettingsEnvironmentSelectorProps {
  readonly environmentId: EnvironmentId;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
}

export function SettingsEnvironmentSelector({
  environmentId,
  environments,
  primaryEnvironmentId,
  onEnvironmentChange,
}: SettingsEnvironmentSelectorProps) {
  const accentColors = useEnvironmentAccentColors();
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;
  const items = useMemo(
    () =>
      environments.map((environment) => ({
        value: environment.environmentId,
        label: environment.label,
      })),
    [environments],
  );
  const SelectedIcon = environmentId === primaryEnvironmentId ? MonitorIcon : CloudIcon;

  return (
    <Select
      value={environmentId}
      items={items}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
    >
      <SelectTrigger size="sm" className="w-36 sm:w-52" aria-label="Settings environment">
        <SelectedIcon
          className="size-3.5"
          style={environmentAccentStyle(accentColors[environmentId])}
        />
        <SelectValue>{selectedEnvironment?.label ?? "Select environment"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectGroupLabel>Configure environment</SelectGroupLabel>
          {environments.map((environment) => {
            const Icon =
              environment.environmentId === primaryEnvironmentId ? MonitorIcon : CloudIcon;
            return (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon
                    className="size-3.5"
                    style={environmentAccentStyle(accentColors[environment.environmentId])}
                  />
                  {environment.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}
