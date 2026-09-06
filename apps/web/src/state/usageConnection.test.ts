import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/unstable/reactivity");
  return {
    presentationsAtom: Atom.make(
      new Map<
        string,
        {
          entry: { target: { label: string } };
          connection: { phase: EnvironmentConnectionPhase; error: null; traceId: null };
        }
      >(),
    ),
    query: Atom.family((_key: string) =>
      Atom.make<AsyncResult.AsyncResult<UsageSummary, Error>>(AsyncResult.initial(true)),
    ),
  };
});
vi.mock("./presentation", () => ({ environmentPresentations: mocks }));
vi.mock("./server", () => ({
  serverEnvironment: { usageSummary: (target: unknown) => mocks.query(JSON.stringify(target)) },
}));

import { usageByWindowAtom } from "./usage";

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};
const environmentId = EnvironmentId.make("remote");
const summary: UsageSummary = {
  ...input,
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-04T12:00:00Z",
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function setup(phase: EnvironmentConnectionPhase) {
  const presentations = new Map([
    [
      environmentId,
      {
        entry: { target: { label: "Remote" } },
        connection: { phase, error: null, traceId: null },
      },
    ],
  ]);
  const registry = AtomRegistry.make({
    initialValues: [[mocks.presentationsAtom, presentations]],
  });
  registries.push(registry);
  const usageQuery = mocks.query(JSON.stringify({ environmentId, input }));
  registry.set(usageQuery, AsyncResult.initial(true));
  const atom = usageByWindowAtom(JSON.stringify(input));
  registry.mount(atom);
  const setPhase = (nextPhase: EnvironmentConnectionPhase) => {
    registry.set(
      mocks.presentationsAtom,
      new Map([
        [
          environmentId,
          {
            ...presentations.get(environmentId)!,
            connection: { phase: nextPhase, error: null, traceId: null },
          },
        ],
      ]),
    );
  };
  return { registry, atom, query: usageQuery, setPhase };
}

describe("usage connection state", () => {
  it.each(["available", "connecting", "reconnecting", "offline", "error"] as const)(
    "does not report an unanswered %s environment as scanning",
    (phase) => {
      const { registry, atom } = setup(phase);
      expect(registry.get(atom)[0]).toMatchObject({ isPending: false, summary: null });
      expect(registry.get(atom)[0]?.error).not.toBeNull();
    },
  );

  it("resumes scanning on connection and clears the error when usage arrives", () => {
    const { registry, atom, query, setPhase } = setup("reconnecting");
    setPhase("connected");
    expect(registry.get(atom)[0]).toMatchObject({ isPending: true, error: null });
    registry.set(query, AsyncResult.success(summary));
    expect(registry.get(atom)[0]).toMatchObject({ isPending: false, error: null, summary });
  });

  it("keeps cached usage with an unavailable status through disconnection and recovery", () => {
    const { registry, atom, query, setPhase } = setup("connected");
    registry.set(query, AsyncResult.waiting(AsyncResult.success(summary)));
    setPhase("reconnecting");
    expect(registry.get(atom)[0]).toMatchObject({ isPending: false, summary });
    expect(registry.get(atom)[0]?.error).not.toBeNull();
    setPhase("connected");
    expect(registry.get(atom)[0]).toMatchObject({ isPending: true, error: null, summary });
  });

  it("preserves the last successful summary when a connected rescan fails", () => {
    const { registry, atom, query } = setup("connected");
    registry.set(
      query,
      AsyncResult.failure(Cause.fail(new Error("scan failed")), {
        previousSuccess: Option.some(AsyncResult.success(summary)),
      }),
    );
    expect(registry.get(atom)[0]).toMatchObject({
      isPending: false,
      error: "Could not report usage",
      summary,
    });
  });
});
