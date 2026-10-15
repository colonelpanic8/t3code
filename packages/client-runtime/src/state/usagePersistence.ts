import { UsageSummary, UsageSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { persistQuery, UsageQueryStore, type QueryPersistence } from "./queryPersistence.ts";

const requestKey = Schema.fromJsonString(Schema.Tuple([Schema.String, UsageSummaryInput]));
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Clients derive the window from the clock, and the 24-hour window moves every
 * minute, so a stored summary is keyed by the window's shape, not its bounds.
 */
export function usageWindowShapeKey(input: UsageSummaryInput): string {
  const span =
    input.resolution === "hour" && input.sinceTime !== undefined && input.untilTime !== undefined
      ? `${Math.round((Date.parse(input.untilTime) - Date.parse(input.sinceTime)) / HOUR_MS)}h`
      : `${Math.round((Date.parse(input.untilDay) - Date.parse(input.sinceDay)) / DAY_MS) + 1}d`;
  return JSON.stringify(["usage-summary", input.timeZone, span]);
}

/**
 * A stored summary only stands in while this session's answer loads, so none of
 * its sources may read as one refresh away from current.
 */
function withoutRefreshingSources(summary: UsageSummary): UsageSummary {
  return {
    ...summary,
    sources: summary.sources.map(({ refreshing: _refreshing, ...source }) => source),
  };
}

export function persistUsageSummary(): QueryPersistence<UsageSummary> {
  const stored = persistQuery(UsageSummary, UsageQueryStore);
  const shapeKey = (key: string) =>
    Schema.decodeEffect(requestKey)(key).pipe(
      Effect.map(([, input]) => usageWindowShapeKey(input)),
    );
  return {
    load: (environmentId, key) =>
      shapeKey(key).pipe(
        Effect.flatMap((shape) => stored.load(environmentId, shape)),
        Effect.map(Option.map(withoutRefreshingSources)),
        Effect.orElseSucceed(() => Option.none()),
      ),
    save: (environmentId, key, summary) =>
      shapeKey(key).pipe(
        Effect.flatMap((shape) => stored.save(environmentId, shape, summary)),
        Effect.ignore,
      ),
  };
}
