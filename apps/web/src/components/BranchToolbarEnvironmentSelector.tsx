import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  environmentAccentStyle,
  resolveEnvironmentAccentColor,
  useEnvironmentAccentColors,
  type EnvironmentAccentColors,
} from "../environmentAccentColors";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
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
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  displayMode?: "toolbar" | "panel";
}

function EnvironmentIcon({
  accentColors,
  environment,
  className,
}: {
  readonly accentColors: EnvironmentAccentColors;
  readonly environment: EnvironmentOption | null;
  readonly className?: string;
}) {
  const accentColor = resolveEnvironmentAccentColor(accentColors, environment?.environmentId);
  const Icon = environment?.isPrimary ? MonitorIcon : CloudIcon;
  return (
    <Icon className={className ?? "size-3 shrink-0"} style={environmentAccentStyle(accentColor)} />
  );
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  displayMode = "toolbar",
}: BranchToolbarEnvironmentSelectorProps) {
  const accentColors = useEnvironmentAccentColors();
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

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <span
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
      >
        <EnvironmentIcon
          accentColors={accentColors}
          environment={activeEnvironment}
          className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0"
        >
          {activeEnvironment?.label ?? "Run on"}
        </span>
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId}
      onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size={displayMode === "panel" ? "default" : "xs"}
        className={cn(
          "min-w-0 max-w-full font-medium",
          displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
        )}
        aria-label="Run on"
      >
        <EnvironmentIcon
          accentColors={accentColors}
          environment={activeEnvironment}
          className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] truncate transition-[max-width,opacity] duration-300 ease-out group-data-[compact]/composer-context:max-w-0 group-data-[compact]/composer-context:opacity-0"
        >
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectPopup
        {...(displayMode === "panel"
          ? {
              alignItemWithTrigger: false,
              popupClassName: THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
            }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentIcon accentColors={accentColors} environment={env} />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
