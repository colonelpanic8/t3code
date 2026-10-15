import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentQueryStore, persistQuery, UsageQueryStore } from "./queryPersistence.ts";

import { persistPullRequestStats } from "./pullRequestStatsPersistence.ts";
import { persistUsageSummary } from "./usagePersistence.ts";
import { usageEnvironmentProgress } from "./usageProgress.ts";

const env = EnvironmentId.make("one");
const other = EnvironmentId.make("two");
const persisted = persistQuery(Schema.Struct({ title: Schema.String }));

function store(records = new Map<string, string>()) {
  return {
    load: (environmentId: EnvironmentId, key: string) =>
      Effect.sync(() => Option.fromUndefinedOr(records.get(`${environmentId}:${key}`))),
    save: (environmentId: EnvironmentId, key: string, payload: string) =>
      Effect.sync(() => {
        records.set(`${environmentId}:${key}`, payload);
      }),
    remove: (environmentId: EnvironmentId, key: string) =>
      Effect.sync(() => {
        records.delete(`${environmentId}:${key}`);
      }),
  };
}

describe("query persistence", () => {
  it.effect("round trips responses without mixing environments or query scopes", () =>
    Effect.gen(function* () {
      yield* persisted.save(env, "open", { title: "saved" });
      expect(yield* persisted.load(env, "open")).toEqual(Option.some({ title: "saved" }));
      expect(yield* persisted.load(other, "open")).toEqual(Option.none());
      expect(yield* persisted.load(env, "closed")).toEqual(Option.none());
    }).pipe(Effect.provideService(EnvironmentQueryStore, store())),
  );

  it.effect("drops corrupt or incompatible records", () => {
    const records = new Map([
      ["one:broken", "not json"],
      ["one:incompatible", '{"title":42}'],
      ["one:valid", '{"title":"kept"}'],
    ]);
    return Effect.gen(function* () {
      expect(yield* persisted.load(env, "broken")).toEqual(Option.none());
      expect(yield* persisted.load(env, "incompatible")).toEqual(Option.none());
      expect(yield* persisted.load(env, "valid")).toEqual(Option.some({ title: "kept" }));
      expect([...records.keys()]).toEqual(["one:valid"]);
    }).pipe(Effect.provideService(EnvironmentQueryStore, store(records)));
  });

  it.effect("does not persist on platforms without a query store", () =>
    Effect.gen(function* () {
      yield* persisted.save(env, "open", { title: "saved" });
      expect(yield* persisted.load(env, "open")).toEqual(Option.none());
    }),
  );
});

it.effect("restores line counts when visible PR batches change", () =>
  Effect.gen(function* () {
    const cache = persistPullRequestStats();
    const first = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
    const second = { ...first, number: 2 };
    const stat = { ...first, additions: 42, deletions: 3 };
    yield* cache.save(env, JSON.stringify(["stats", { refs: [first, second] }]), { stats: [stat] });
    const key = JSON.stringify(["stats", { refs: [first] }]);
    expect(yield* cache.load(env, key)).toEqual(Option.some({ stats: [stat] }));
    expect(yield* cache.load(other, key)).toEqual(Option.none());
  }).pipe(Effect.provideService(EnvironmentQueryStore, store())),
);

describe("usage summary persistence", () => {
  const cache = persistUsageSummary();
  const label = "environment-data:server:usage-summary";
  const hourly = (sinceTime: string, untilTime: string): UsageSummaryInput => ({
    sinceDay: UsageDay.make(sinceTime.slice(0, 10)),
    untilDay: UsageDay.make(untilTime.slice(0, 10)),
    timeZone: "UTC",
    resolution: "hour",
    sinceTime,
    untilTime,
  });
  const morning = hourly("2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z");
  const afternoon = hourly("2026-10-13T13:37:00.000Z", "2026-10-14T13:37:00.000Z");
  const daily = (sinceDay: string, untilDay: string): UsageSummaryInput => ({
    sinceDay: UsageDay.make(sinceDay),
    untilDay: UsageDay.make(untilDay),
    timeZone: "UTC",
    resolution: "day",
  });
  const runtimeKey = (input: UsageSummaryInput) => JSON.stringify([label, input]);
  const summary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-10-14T09:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-10-13"),
    untilDay: UsageDay.make("2026-10-14"),
    buckets: [],
    sources: [
      {
        fingerprint: {
          hostId: "host",
          provider: "cursor",
          resolvedHomePath: "/cursor",
          volumeId: "volume",
        },
        status: "ok",
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 0,
        message: null,
        refreshing: true,
      },
    ],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
  const { refreshing: _refreshing, ...settledSource } = summary.sources[0]!;

  it.effect("finds the last 24-hour summary from a window that has since moved", () =>
    Effect.gen(function* () {
      yield* cache.save(env, runtimeKey(morning), summary);
      const later = runtimeKey(afternoon);
      expect(yield* cache.load(env, later)).toEqual(
        Option.some({ ...summary, sources: [settledSource] }),
      );
      expect(yield* cache.load(other, later)).toEqual(Option.none());
      expect(yield* cache.load(env, runtimeKey(daily("2026-10-08", "2026-10-14")))).toEqual(
        Option.none(),
      );
      expect(yield* cache.load(env, runtimeKey({ ...afternoon, timeZone: "Asia/Tokyo" }))).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provideService(UsageQueryStore, store())),
  );

  it.effect("keeps day windows of different lengths apart", () =>
    Effect.gen(function* () {
      yield* cache.save(env, runtimeKey(daily("2026-10-08", "2026-10-14")), summary);
      expect(
        Option.isSome(yield* cache.load(env, runtimeKey(daily("2026-10-08", "2026-10-14")))),
      ).toBe(true);
      expect(yield* cache.load(env, runtimeKey(daily("2026-09-15", "2026-10-14")))).toEqual(
        Option.none(),
      );
    }).pipe(Effect.provideService(UsageQueryStore, store())),
  );

  it.effect("reads a restored summary as wholly stale while its environment rescans", () =>
    Effect.gen(function* () {
      const key = runtimeKey(morning);
      yield* cache.save(env, key, summary);
      const restored = Option.getOrThrow(yield* cache.load(env, key));
      // The query presents a restored value as waiting until its refetch lands.
      expect(
        usageEnvironmentProgress({
          label: "local",
          isConnected: true,
          isPending: true,
          error: null,
          summary: restored,
        }),
      ).toEqual({ phase: "stale" });
    }).pipe(Effect.provideService(UsageQueryStore, store())),
  );

  it.effect("stays out of the pull request query store", () =>
    Effect.gen(function* () {
      const key = runtimeKey(morning);
      yield* cache.save(env, key, summary);
      expect(yield* cache.load(env, key)).toEqual(Option.none());
    }).pipe(Effect.provideService(EnvironmentQueryStore, store())),
  );
});
