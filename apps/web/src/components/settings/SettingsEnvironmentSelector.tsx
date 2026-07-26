import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useSettingsEnvironment } from "../../hooks/useSettingsEnvironment";
import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { Button } from "../ui/button";
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
  readonly triggerClassName?: string;
}

export function SettingsEnvironmentSelector({
  environmentId,
  environments,
  primaryEnvironmentId,
  onEnvironmentChange,
  triggerClassName,
}: SettingsEnvironmentSelectorProps) {
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

  return (
    <Select
      value={environmentId}
      items={items}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
    >
      <SelectTrigger
        size="sm"
        className={cn("w-36 sm:w-52", triggerClassName)}
        aria-label="Settings environment"
      >
        {environmentId === primaryEnvironmentId ? (
          <MonitorIcon className="size-3.5" />
        ) : (
          <CloudIcon className="size-3.5" />
        )}
        <SelectValue>{selectedEnvironment?.label ?? "Select environment"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectGroupLabel>Configure environment</SelectGroupLabel>
          {environments.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {environment.environmentId === primaryEnvironmentId ? (
                  <MonitorIcon className="size-3.5" />
                ) : (
                  <CloudIcon className="size-3.5" />
                )}
                {environment.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

interface SettingsEnvironmentControlProps {
  readonly triggerClassName?: string;
  readonly fallbackClassName?: string;
}

export function SettingsEnvironmentControl({
  triggerClassName,
  fallbackClassName,
}: SettingsEnvironmentControlProps = {}) {
  const {
    environmentId,
    environment,
    environments,
    primaryEnvironmentId,
    selectEnvironment,
    isReady,
  } = useSettingsEnvironment();

  if (environmentId !== null && environment !== null) {
    return (
      <SettingsEnvironmentSelector
        environmentId={environmentId}
        environments={environments}
        primaryEnvironmentId={primaryEnvironmentId}
        onEnvironmentChange={selectEnvironment}
        {...(triggerClassName === undefined ? {} : { triggerClassName })}
      />
    );
  }

  if (isReady) {
    return (
      <Button
        render={<Link to="/settings/connections" />}
        size="xs"
        variant="outline"
        className={fallbackClassName}
      >
        Connect environment
      </Button>
    );
  }

  return (
    <Button size="xs" variant="outline" className={fallbackClassName} disabled>
      Loading environments
    </Button>
  );
}

export function SettingsEnvironmentSidebarControl() {
  return (
    <div className="px-2 pb-2 group-data-[collapsible=icon]:hidden">
      <SettingsEnvironmentControl
        triggerClassName="w-full justify-between border-sidebar-border/70 bg-sidebar-accent/25 text-sidebar-foreground shadow-none sm:w-full"
        fallbackClassName="w-full"
      />
    </div>
  );
}
