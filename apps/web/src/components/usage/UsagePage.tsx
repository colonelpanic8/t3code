import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { CircleAlertIcon, ChevronDownIcon, InfoIcon, SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";

import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";
import { enumeratePeriods, type UsageTimeGrouping } from "@t3tools/shared/usagePivot";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageBreakdownTable, usageTableView } from "./UsageBreakdownTable";
import { UsageChart } from "./UsageChart";
import { ProviderMark } from "./ProviderMark";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import { costTypeSegments, speedCostSegments, tokenTypeSegments } from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import {
  DEFAULT_USAGE_VIEW,
  USAGE_CHART_DIMENSIONS,
  USAGE_DAY_GROUPINGS,
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import {
  DIMENSION_NAMES,
  GROUPING_ADJECTIVES,
  GROUPING_NAMES,
  buildUsageChartSeries,
} from "./usageSeries";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

/** A provider set that keeps its identity while its members stay the same. */
function useProviderSet(providers: readonly UsageProviderKind[]): ReadonlySet<UsageProviderKind> {
  const key = providers.join(",");
  return useMemo(() => {
    const members = key.split(",");
    return new Set(PROVIDER_ORDER.filter((provider) => members.includes(provider)));
  }, [key]);
}

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  useEscapeToGoBack();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut ? `${option.label} (${shortcut})` : option.label;
  };
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const hiddenProviders = useMemo(
    () => new Set(preferences.hiddenProviders),
    [preferences.hiddenProviders],
  );
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = shown !== null && shown.window !== window;
  const loading = useMemo(() => {
    if (showingKept) {
      return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
    }
    const state = usageLoadingState(selectedEnvironments, refreshingUsage);
    const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
    return {
      partial: state.everyProvider || providers.size > 0,
      everyProvider: state.everyProvider,
      providers,
    };
  }, [showingKept, refreshingUsage, selectedEnvironments, hiddenProviders]);
  const isProviderLoading = (provider: UsageProviderKind) =>
    loading.everyProvider || loading.providers.has(provider);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const cursorAccessEnvironments = hiddenProviders.has("cursor")
    ? []
    : cursorKeychainAccessEnvironments(selectedEnvironments);
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !source.action &&
            !hiddenProviders.has(source.fingerprint.provider) &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = useMemo(
    () => enumerateDays(shownWindow.sinceDay, shownWindow.untilDay),
    [shownWindow.sinceDay, shownWindow.untilDay],
  );
  const hours = useMemo(
    () =>
      shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
        ? []
        : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime),
    [shownWindow.sinceTime, shownWindow.untilTime],
  );
  const grouping: UsageTimeGrouping = shownHourly
    ? "hour"
    : (preferences.timeGrouping ?? DEFAULT_USAGE_VIEW.timeGrouping);
  const groupingOptions: readonly UsageTimeGrouping[] = shownHourly
    ? ["hour"]
    : USAGE_DAY_GROUPINGS;
  const periods = useMemo(
    () => enumeratePeriods(shownHourly ? hours : days, grouping),
    [days, grouping, hours, shownHourly],
  );
  const chartDimensions = preferences.chartDimensions ?? DEFAULT_USAGE_VIEW.chartDimensions;
  const chartSeries = useMemo(
    () =>
      buildUsageChartSeries(
        merged.entries,
        chartDimensions,
        grouping,
        periods,
        metric === "tokens" ? "tokens" : "cost",
      ),
    [chartDimensions, grouping, merged.entries, metric, periods],
  );
  const tableView = useMemo(
    () =>
      usageTableView(
        { tableDimensions: preferences.tableDimensions, sort: preferences.sort },
        metric === "tokens" ? "tokens" : "cost",
      ),
    [metric, preferences.sort, preferences.tableDimensions],
  );
  // Keyed by content: environment statuses change identity on every update.
  const environmentLabelsKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const environmentLabels = useMemo(
    () => new Map(JSON.parse(environmentLabelsKey) as [EnvironmentId, string][]),
    [environmentLabelsKey],
  );
  const providersWithData = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const activeProviders = useMemo(
    () =>
      PROVIDER_ORDER.filter(
        (provider) => providersWithData.includes(provider) || loading.providers.has(provider),
      ),
    [loading.providers, providersWithData],
  );
  const loadingProviders = useProviderSet(PROVIDER_ORDER.filter(isProviderLoading));
  const chartLoadingProviders = useProviderSet(activeProviders.filter(isProviderLoading));
  const selectedModel =
    selectedModelKey === null
      ? undefined
      : merged.models.find((model) => `${model.provider}:${model.model}` === selectedModelKey);
  const summaryRows: Array<
    | { readonly kind: "usage"; readonly provider: UsageProviderKind }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = activeProviders.map((provider) => ({ kind: "usage", provider }));
  const cursorInsertAt =
    Math.max(activeProviders.indexOf("codex"), activeProviders.indexOf("claude")) + 1;
  summaryRows.splice(
    cursorInsertAt,
    0,
    ...cursorAccessEnvironments.map((environment) => ({ kind: "enable" as const, environment })),
  );

  const savedPreferences = useRef(preferences);
  useEffect(() => {
    if (savedPreferences.current === preferences) return;
    savedPreferences.current = preferences;
    saveUsagePagePreferences(preferences);
  }, [preferences]);
  const updatePreferences = useCallback(
    (patch: Partial<UsagePagePreferences>) =>
      setPreferences((current) => ({ ...current, ...patch })),
    [],
  );
  const openModel = useCallback(
    (row: { readonly provider?: UsageProviderKind; readonly model: string }) =>
      setSelectedModelKey(`${row.provider}:${row.model}`),
    [],
  );
  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setLimitsNow(Date.now());
    updatePreferences({ metric: nextMetric });
  };
  const refreshLimits = async (automatic = false, afterPending = false) => {
    try {
      await Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
              afterPending,
            );
          }
        }),
      );
    } finally {
      setLimitsNow(Date.now());
    }
  };
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  useEffect(() => {
    if (showingLimits && connectedLimitsEnvironments) autoRefreshLimits();
  }, [showingLimits, connectedLimitsEnvironments]);

  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? `${formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone)} to ${formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone)}`
      : `${formatDayShort(shownWindow.sinceDay)} to ${formatDayShort(shownWindow.untilDay)}`;
  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2 xl:flex">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem className="min-w-10 shrink">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            refreshing={refreshingUsage}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageProviderFilter
            hiddenProviders={hiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground 2xl:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 xl:flex">
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          disabled={showingLimits}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 xl:hidden">
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={String(windowDays)}
          disabled={showingLimits}
          onValueChange={(value) => selectWindow(Number(value))}
        >
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem
                key={option.days}
                value={String(option.days)}
                title={shortcutTitle(option)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? `Connect an environment to see ${showingLimits ? "limits" : "usage"}.`
                  : `Select an environment to see ${showingLimits ? "limits" : "usage"}.`}
              </p>
            ) : showingLimits ? (
              <UsageLimitsSection
                selectedEnvironmentIds={selectedEnvironmentIds}
                hiddenProviders={hiddenProviders}
                now={limitsNow}
                cursorPrompt={
                  cursorAccessEnvironments.length > 0 ? (
                    <CursorEnableLimits
                      environments={cursorAccessEnvironments}
                      onEnabled={() => {
                        void refresh();
                        void refreshLimits(false, true);
                      }}
                    />
                  ) : null
                }
              />
            ) : shown === null ? (
              <UsageSkeleton />
            ) : !canReadDiagnostics ? (
              <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                {selectedEnvironments.map((environment) => (
                  <p key={environment.environmentId}>
                    {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                    {environment.error}
                  </p>
                ))}
              </div>
            ) : (
              <div aria-busy={loading.partial} className="flex flex-col gap-6">
                {sourceMessages.map((message) => (
                  <p key={message} className="mb-4 text-sm text-muted-foreground">
                    {message}
                  </p>
                ))}
                <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span
                        className={cn(
                          "text-4xl font-semibold text-foreground tabular-nums",
                          figureClass(loading.partial),
                        )}
                      >
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <span>
                          <span className={figureClass(loading.partial)}>
                            {formatCount(merged.sessions)} sessions
                          </span>
                          {metric === "cost" && " · API estimate"}
                        </span>
                        {metric === "cost" && merged.costQuality.unpricedShare > 0 && (
                          <Popover>
                            <PopoverTrigger
                              openOnHover
                              render={<InlineButton tone="muted" />}
                              aria-label="Unpriced usage details"
                            >
                              <InfoIcon className="size-3" aria-hidden />
                            </PopoverTrigger>
                            <PopoverPopup side="top" tooltipStyle>
                              API estimate excludes{" "}
                              {formatPercent(merged.costQuality.unpricedShare)} unpriced records.
                            </PopoverPopup>
                          </Popover>
                        )}
                      </span>
                    </div>

                    {!hiddenProviders.has("codex") &&
                    [...presentations].some(
                      ([id, presentation]) =>
                        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
                        presentation.serverConfig?.providers.some(usesChatGptSharing),
                    ) ? (
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>ChatGPT shared usage</span>
                        <ChatGptUsageButton size="xs" />
                      </div>
                    ) : null}

                    {summaryRows.map((row) => {
                      if (row.kind === "enable") {
                        return (
                          <CursorEnableRow
                            key={`enable:${row.environment.environmentId}`}
                            environmentId={row.environment.environmentId}
                            label={row.environment.label}
                            showEnvironment={selectedEnvironments.length > 1}
                            onEnabled={() => {
                              void refresh();
                              void refreshLimits(false, true);
                            }}
                          />
                        );
                      }
                      const provider = row.provider;
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                      const providerSessions = totals?.sessions ?? 0;
                      const sessionLabel = `${formatCount(providerSessions)} ${
                        providerSessions === 1 ? "session" : "sessions"
                      }`;
                      const providerLoading = isProviderLoading(provider);
                      const awaitingData = providerLoading && !providersWithData.includes(provider);
                      return (
                        <div key={provider} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                                <span
                                  className={cn(
                                    "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                                    figureClass(providerLoading),
                                    awaitingData && "invisible",
                                  )}
                                >
                                  {sessionLabel}
                                </span>
                              </span>
                            </span>
                            <span
                              className={cn(
                                "shrink-0 text-sm font-medium text-foreground tabular-nums",
                                figureClass(providerLoading),
                              )}
                            >
                              {awaitingData
                                ? "—"
                                : metric === "cost"
                                  ? formatUsd(totals?.costUsd ?? 0)
                                  : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "text-xs text-muted-foreground",
                              figureClass(providerLoading),
                              awaitingData && "invisible",
                            )}
                          >
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-medium text-foreground">
                        {GROUPING_ADJECTIVES[grouping]}{" "}
                        {metric === "tokens" ? "processed tokens" : "cost"}
                      </h2>
                      <div className="flex flex-wrap items-center gap-2">
                        <ToggleGroup
                          aria-label="Chart by"
                          variant="segmented"
                          multiple
                          value={[...chartDimensions]}
                          onValueChange={(next) =>
                            updatePreferences({
                              chartDimensions: USAGE_CHART_DIMENSIONS.filter((dimension) =>
                                next.includes(dimension),
                              ),
                            })
                          }
                        >
                          {USAGE_CHART_DIMENSIONS.map((dimension) => (
                            <Toggle key={dimension} value={dimension}>
                              {DIMENSION_NAMES[dimension]}
                            </Toggle>
                          ))}
                        </ToggleGroup>
                        <ToggleGroup
                          aria-label="Time grouping"
                          variant="segmented"
                          value={[grouping]}
                          onValueChange={(next) => {
                            const value = USAGE_DAY_GROUPINGS.find((option) => option === next[0]);
                            if (value) updatePreferences({ timeGrouping: value });
                          }}
                        >
                          {groupingOptions.map((option) => (
                            <Toggle key={option} value={option}>
                              {GROUPING_NAMES[option]}
                            </Toggle>
                          ))}
                        </ToggleGroup>
                      </div>
                    </div>
                    <UsageChart
                      series={chartSeries}
                      grouping={grouping}
                      metric={metric}
                      environmentLabels={environmentLabels}
                      loadingProviders={chartLoadingProviders}
                      referenceTime={shownWindow.untilTime}
                      timeZone={shownWindow.timeZone}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric
                      loading={loading.partial}
                      label="Processed tokens"
                      value={formatTokens(merged.totalTokens)}
                    />
                    <Metric
                      loading={loading.partial}
                      label="Cached input"
                      value={formatTokens(merged.cachedInputTokens)}
                    />
                    <Metric
                      loading={loading.partial}
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric
                      loading={loading.partial}
                      label="Output"
                      value={formatTokens(merged.outputTokens)}
                    />
                    <Metric
                      loading={loading.partial}
                      label="Cache savings"
                      value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    />
                  </div>
                </section>

                {merged.totalTokens > 0 ? (
                  <section
                    className={cn(
                      "grid gap-x-12 gap-y-8 lg:grid-cols-2",
                      figureClass(loading.partial),
                    )}
                  >
                    {metric === "tokens" ? (
                      <UsageShareBar
                        label="Tokens by type"
                        segments={tokenTypeSegments(merged)}
                        format={formatTokens}
                      />
                    ) : (
                      <>
                        <UsageShareBar
                          label="Cost by type"
                          segments={costTypeSegments(merged.categoryCost)}
                          format={formatUsd}
                        />
                        {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                          <UsageShareBar
                            label="Cost by speed"
                            segments={speedCostSegments(merged.speedCost)}
                            format={formatUsd}
                            aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
                          />
                        ) : null}
                      </>
                    )}
                  </section>
                ) : null}

                <UsageBreakdownTable
                  entries={merged.entries}
                  view={tableView}
                  chartSeries={chartSeries}
                  onViewChange={updatePreferences}
                  grouping={grouping}
                  metric={metric}
                  environmentLabels={environmentLabels}
                  timeZone={shownWindow.timeZone}
                  loadingProviders={loadingProviders}
                  onOpenModel={openModel}
                />
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {selectedModel !== undefined && !showingLimits ? (
        <UsageModelDialog
          model={selectedModel}
          environments={selectedEnvironments}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            periods,
            grouping,
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
          }}
          onSetPrice={() => {
            setSelectedModelKey(null);
            setPriceDialog({ model: selectedModel.model });
          }}
          onClose={() => setSelectedModelKey(null)}
        />
      ) : null}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

function CursorEnableButton({
  environmentId,
  label,
  onEnabled,
  tooltip,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly tooltip: boolean;
  readonly buttonText?: string;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: true } },
      });
      if (result._tag === "Success") onEnabled();
    } finally {
      setPending(false);
    }
  };
  const button = tooltip ? (
    <InlineButton
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </InlineButton>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{CURSOR_KEYCHAIN_COPY}</TooltipPopup>
    </Tooltip>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly onEnabled: () => void;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_PRESENTATION.cursor.color }}
        />
        <ProviderMark provider="cursor" className="size-4" />
        <span className="truncate">Cursor{showEnvironment ? ` · ${label}` : ""}</span>
      </span>
      <CursorEnableButton
        environmentId={environmentId}
        label={label}
        onEnabled={onEnabled}
        tooltip
      />
    </div>
  );
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_KEYCHAIN_COPY}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
              tooltip={false}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function Metric({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}
      >
        {value}
      </span>
    </div>
  );
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {environment.label}: {environment.error}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label="Some environments could not report usage"
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-0 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status =
            environment.error !== null
              ? "Unavailable"
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? "Update required"
                : !environment.isConnected
                  ? "Connecting…"
                  : progress.phase === "loading"
                    ? "Scanning…"
                    : progress.phase === "stale"
                      ? "Refreshing…"
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel)
                        : "Ready";
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Totals are partial while selected environments scan.
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          Model prices
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? "All providers"
      : visible.length === 0
        ? "No providers"
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : `${visible.length} providers`;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          All providers
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(
                PROVIDER_ORDER.filter((entry) =>
                  entry === provider ? !checked : hiddenProviders.has(entry),
                ),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={provider} className="size-3.5" />
              <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <MetricSkeletons
          labels={["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"]}
        />
      </section>

      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-2" />
          <Skeleton className="h-4 w-72" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
