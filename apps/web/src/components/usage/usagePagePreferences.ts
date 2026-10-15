import { UsageProviderKind } from "@t3tools/contracts";
import {
  USAGE_DIMENSIONS,
  USAGE_SORT_FIELDS,
  type UsageDayGrouping,
  type UsageDimension,
  type UsageSortCriterion,
} from "@t3tools/shared/usagePivot";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
// View settings are stored loosely and validated field by field, so one value
// this build does not know drops only that setting, not the whole save.
const StoredPreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
  chartDimensions: Schema.optional(Schema.Array(Schema.String)),
  tableDimensions: Schema.optional(Schema.Array(Schema.String)),
  sort: Schema.optional(
    Schema.Array(Schema.Struct({ field: Schema.String, direction: Schema.String })),
  ),
  timeGrouping: Schema.optional(Schema.String),
});

export type UsageChartDimension = Exclude<UsageDimension, "period">;
export const USAGE_CHART_DIMENSIONS = [
  "environment",
  "provider",
  "model",
] as const satisfies readonly UsageChartDimension[];
export const USAGE_DAY_GROUPINGS = [
  "day",
  "week",
  "month",
] as const satisfies readonly UsageDayGrouping[];

export interface UsagePagePreferences {
  readonly metric: "cost" | "tokens" | "limits";
  readonly windowDays: 1 | 7 | 30 | 90;
  readonly hiddenProviders?: readonly UsageProviderKind[];
  readonly chartDimensions?: readonly UsageChartDimension[];
  readonly tableDimensions?: readonly UsageDimension[];
  /** Absent until the user picks a sort: the default follows the metric. */
  readonly sort?: readonly UsageSortCriterion[] | undefined;
  readonly timeGrouping?: UsageDayGrouping;
}

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export const DEFAULT_USAGE_VIEW = {
  // Matches the per-provider chart from before series became configurable.
  chartDimensions: ["provider"],
  tableDimensions: ["model"],
  timeGrouping: "day",
} as const satisfies Required<
  Pick<UsagePagePreferences, "chartDimensions" | "tableDimensions" | "timeGrouping">
>;

function isOneOf<const T extends string>(options: readonly T[], value: string): value is T {
  return (options as readonly string[]).includes(value);
}

function parseDimensions<const T extends string>(
  options: readonly T[],
  values: readonly string[] | undefined,
): readonly T[] | undefined {
  if (values === undefined || !values.every((value) => isOneOf(options, value))) return undefined;
  return [...new Set(values)];
}

function parseSort(
  values: readonly { field: string; direction: string }[] | undefined,
): readonly UsageSortCriterion[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const criteria: UsageSortCriterion[] = [];
  for (const { field, direction } of values) {
    if (!isOneOf(USAGE_SORT_FIELDS, field) || !isOneOf(["ascending", "descending"], direction)) {
      return undefined;
    }
    if (!criteria.some((criterion) => criterion.field === field)) {
      criteria.push({ field, direction });
    }
  }
  return criteria;
}

function parsePreferences(stored: typeof StoredPreferencesSchema.Type): UsagePagePreferences {
  const chartDimensions = parseDimensions(USAGE_CHART_DIMENSIONS, stored.chartDimensions);
  const tableDimensions = parseDimensions(USAGE_DIMENSIONS, stored.tableDimensions);
  const sort = parseSort(stored.sort);
  const timeGrouping =
    stored.timeGrouping !== undefined && isOneOf(USAGE_DAY_GROUPINGS, stored.timeGrouping)
      ? stored.timeGrouping
      : undefined;
  return {
    metric: stored.metric,
    windowDays: stored.windowDays,
    ...(stored.hiddenProviders === undefined ? {} : { hiddenProviders: stored.hiddenProviders }),
    ...(chartDimensions === undefined ? {} : { chartDimensions }),
    ...(tableDimensions === undefined ? {} : { tableDimensions }),
    ...(sort === undefined ? {} : { sort }),
    ...(timeGrouping === undefined ? {} : { timeGrouping }),
  };
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, StoredPreferencesSchema);
    return stored === null ? DEFAULT_PREFERENCES : parsePreferences(stored);
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, StoredPreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
