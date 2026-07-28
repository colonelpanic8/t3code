import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerShortcutKeycap } from "./chat/ComposerControlShortcutHint";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutHintLabel?: string | null;
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  open,
  onOpenChange,
  shortcutHintLabel,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () =>
      availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    [availableEnvironments],
  );

  if (envLocked || onEnvironmentChange === undefined) {
    // The indicator still renders so remote projects stay identifiable, but it
    // is inert here — say why, since it otherwise reads as a dead control.
    const inertReason = envLocked
      ? "This thread already started, so it cannot move to another environment"
      : "The only environment available for this project";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs" />
          }
        >
          {activeEnvironment?.isPrimary ? (
            <MonitorIcon className="size-3 shrink-0" />
          ) : (
            <CloudIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">{activeEnvironment?.label ?? "Run on"}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{inertReason}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className={cn(
          "min-w-0 max-w-full font-medium",
          shortcutHintLabel && "[&_[data-slot=select-icon]]:hidden",
        )}
        aria-label="Run on"
      >
        {activeEnvironment?.isPrimary ? (
          <MonitorIcon className="size-3 shrink-0" />
        ) : (
          <CloudIcon className="size-3 shrink-0" />
        )}
        <SelectValue />
        {shortcutHintLabel ? <ComposerShortcutKeycap label={shortcutHintLabel} /> : null}
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                {env.isPrimary ? (
                  <MonitorIcon className="size-3" />
                ) : (
                  <CloudIcon className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
