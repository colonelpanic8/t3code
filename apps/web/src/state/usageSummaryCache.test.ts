import { UsageQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { persistUsageSummary } from "@t3tools/client-runtime/state/usage-persistence";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { makeUsageSummaryStore, type UsageSummaryBackend } from "./usageSummaryCache";

const environmentId = EnvironmentId.make("local");
const label = "environment-data:server:usage-summary";
const hourly = (sinceTime: string, untilTime: string): UsageSummaryInput => ({
  sinceDay: UsageDay.make(sinceTime.slice(0, 10)),
  untilDay: UsageDay.make(untilTime.slice(0, 10)),
  timeZone: "UTC",
  resolution: "hour",
  sinceTime,
  untilTime,
});
const keyFor = (input: UsageSummaryInput) => JSON.stringify([label, input]);
const morning = keyFor(hourly("2026-10-13T09:00:00.000Z", "2026-10-14T09:00:00.000Z"));
const evening = keyFor(hourly("2026-10-13T21:15:00.000Z", "2026-10-14T21:15:00.000Z"));
const week = keyFor({
  sinceDay: UsageDay.make("2026-10-08"),
  untilDay: UsageDay.make("2026-10-14"),
  timeZone: "UTC",
  resolution: "day",
});
const summary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-10-14T09:00:00Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-10-13"),
  untilDay: UsageDay.make("2026-10-14"),
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};

function harness(start: string, maxEntries?: number) {
  const records = new Map<string, unknown>();
  let now = Date.parse(start);
  const backend: UsageSummaryBackend = {
    get: (id) => Effect.sync(() => records.get(id)),
    put: (id, record) => Effect.sync(() => void records.set(id, record)),
    remove: (ids) => Effect.sync(() => ids.forEach((id) => records.delete(id))),
    entries: Effect.sync(() => [...records]),
  };
  const store = makeUsageSummaryStore(backend, {
    now: () => now,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  return {
    records,
    setNow: (instant: string) => {
      now = Date.parse(instant);
    },
    run: <A>(effect: Effect.Effect<A>) =>
      effect.pipe(Effect.provideService(UsageQueryStore, store)),
  };
}

const cache = persistUsageSummary();

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("usage summary cache", () => {
  it.effect("restores the last 24-hour summary for a window that has since moved", () => {
    const { run } = harness("2026-10-14T09:00:00Z");
    return run(
      Effect.gen(function* () {
        yield* cache.save(environmentId, morning, summary);
        expect(yield* cache.load(environmentId, evening)).toEqual(Option.some(summary));
        expect(yield* cache.load(EnvironmentId.make("remote"), evening)).toEqual(Option.none());
      }),
    );
  });

  it.effect("forgets summaries once local midnight passes", () => {
    const { run, records, setNow } = harness("2026-10-14T23:00:00Z");
    return run(
      Effect.gen(function* () {
        yield* cache.save(environmentId, morning, summary);
        yield* cache.save(environmentId, week, summary);
        setNow("2026-10-15T00:01:00Z");
        expect(yield* cache.load(environmentId, morning)).toEqual(Option.none());
        expect(records.size).toBe(1);
        yield* cache.save(EnvironmentId.make("remote"), morning, summary);
        expect([...records.keys()]).toEqual([`remote:["usage-summary","UTC","24h"]`]);
      }),
    );
  });

  it.effect("keeps only the most recently saved summaries", () => {
    const { run, records, setNow } = harness("2026-10-14T09:00:00Z", 2);
    return run(
      Effect.gen(function* () {
        for (const [index, id] of ["a", "b", "c"].entries()) {
          setNow(`2026-10-14T09:0${index}:00Z`);
          yield* cache.save(EnvironmentId.make(id), morning, summary);
        }
        expect([...records.keys()].map((key) => key.split(":")[0])).toEqual(["b", "c"]);
      }),
    );
  });

  it.effect("drops records this client can no longer read", () => {
    const { run, records } = harness("2026-10-14T09:00:00Z");
    return run(
      Effect.gen(function* () {
        yield* cache.save(environmentId, morning, summary);
        const storedKey = `local:["usage-summary","UTC","24h"]`;
        const { buckets: _buckets, ...withoutBuckets } = summary;
        records.set(storedKey, {
          payload: JSON.stringify({ ...withoutBuckets, contractVersion: 99 }),
          savedAt: Date.parse("2026-10-14T09:00:00Z"),
        });
        records.set("local:malformed", { payload: 42 });
        expect(yield* cache.load(environmentId, evening)).toEqual(Option.none());
        expect([...records.keys()]).toEqual(["local:malformed"]);
        yield* cache.save(environmentId, week, summary);
        expect([...records.keys()]).toEqual([`local:["usage-summary","UTC","7d"]`]);
      }),
    );
  });
});
