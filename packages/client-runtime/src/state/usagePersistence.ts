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
function usageWindowShapeKey(input: UsageSummaryInput): string {
  const hours = hourBounds(input);
  const span =
    hours === null
      ? `${Math.round((Date.parse(input.untilDay) - Date.parse(input.sinceDay)) / DAY_MS) + 1}d`
      : `${Math.round((hours.until - hours.since) / HOUR_MS)}h`;
  return JSON.stringify(["usage-summary", input.timeZone, span]);
}

function hourBounds(input: UsageSummaryInput) {
  return input.resolution === "hour" &&
    input.sinceTime !== undefined &&
    input.untilTime !== undefined
    ? { since: Date.parse(input.sinceTime), until: Date.parse(input.untilTime) }
    : null;
}

/**
 * Judge a stored summary by the window it answered, not when it was saved. An hourly summary
 * read before the window began says nothing about it; otherwise keep only the hours inside it.
 * Session counts cover the whole window and cannot be clipped, acceptable for stale usage.
 */
function fitToWindow(summary: UsageSummary, input: UsageSummaryInput): Option.Option<UsageSummary> {
  const hours = hourBounds(input);
  if (hours === null) {
    return summary.sinceDay === input.sinceDay && summary.untilDay === input.untilDay
      ? Option.some(summary)
      : Option.none();
  }
  if (Date.parse(summary.readAt) <= hours.since) return Option.none();
  return Option.some({
    ...summary,
    buckets: summary.buckets.filter((bucket) => {
      if (bucket.hourStart === undefined) return false;
      const start = Date.parse(bucket.hourStart);
      return start >= hours.since && start < hours.until;
    }),
  });
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
  const requestInput = (key: string) =>
    Schema.decodeEffect(requestKey)(key).pipe(Effect.map(([, input]) => input));
  return {
    load: (environmentId, key) =>
      requestInput(key).pipe(
        Effect.flatMap((input) =>
          stored
            .load(environmentId, usageWindowShapeKey(input))
            .pipe(Effect.map(Option.flatMap((summary) => fitToWindow(summary, input)))),
        ),
        Effect.map(Option.map(withoutRefreshingSources)),
        Effect.orElseSucceed(() => Option.none()),
      ),
    save: (environmentId, key, summary) =>
      requestInput(key).pipe(
        Effect.flatMap((input) => stored.save(environmentId, usageWindowShapeKey(input), summary)),
        Effect.ignore,
      ),
  };
}
