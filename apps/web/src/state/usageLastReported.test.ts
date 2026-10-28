import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { usageEnvironmentProgress } from "@t3tools/client-runtime/state/usage-progress";
import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { AuthDiagnosticsReadScope } = await import("@t3tools/contracts");
  return {
    session: Atom.make(
      AsyncResult.success({
        authenticated: true,
        scopes: [AuthDiagnosticsReadScope],
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "t3_session",
        },
      }),
    ),
    presentationsAtom: Atom.make(
      new Map<
        string,
        {
          entry: { target: { label: string } };
          connection: { phase: EnvironmentConnectionPhase; error: null; traceId: null };
        }
      >(),
    ),
    query: Atom.make<AsyncResult.AsyncResult<UsageSummary, Error>>(AsyncResult.initial(true)),
    providers: Atom.make(null),
  };
});
vi.mock("./presentation", () => ({ environmentPresentations: mocks }));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => mocks.session },
  readEnvironmentScope: () => true,
}));
vi.mock("./server", () => ({
  serverEnvironment: {
    usageSummary: () => mocks.query,
    providersValueAtom: () => mocks.providers,
  },
}));

import { usageByWindowAtom } from "./usage";

const input = {
  sinceDay: UsageDay.make("2026-10-14"),
  untilDay: UsageDay.make("2026-10-14"),
  timeZone: "UTC",
};
const environmentId = EnvironmentId.make("remote");
const summary: UsageSummary = {
  ...input,
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-10-14T12:00:00Z",
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function presentations(phase: EnvironmentConnectionPhase) {
  return new Map([
    [
      environmentId,
      { entry: { target: { label: "Remote" } }, connection: { phase, error: null, traceId: null } },
    ],
  ]);
}

describe("restored usage from an environment that is not connected", () => {
  function mountWith(phase: EnvironmentConnectionPhase) {
    const registry = AtomRegistry.make({
      initialValues: [
        [mocks.presentationsAtom, presentations(phase)],
        // A persisted summary settles while its environment cannot answer.
        [mocks.query, AsyncResult.success(summary)],
      ],
    });
    registries.push(registry);
    const atom = usageByWindowAtom(JSON.stringify(input));
    registry.mount(atom);
    return { registry, atom, status: () => registry.get(atom)[0]! };
  }

  it("reads as stale, not failed, while its environment first connects", () => {
    const { registry, status } = mountWith("connecting");
    expect(status()).toMatchObject({
      isPending: false,
      isConnected: false,
      isConnecting: true,
      error: null,
      summary,
    });
    expect(usageEnvironmentProgress(status())).toEqual({ phase: "stale" });

    registry.set(mocks.presentationsAtom, presentations("connected"));
    registry.set(mocks.query, AsyncResult.waiting(AsyncResult.success(summary)));
    expect(status()).toMatchObject({ isPending: true, error: null, summary });
    expect(usageEnvironmentProgress(status())).toEqual({ phase: "stale" });
  });

  it("stays out of the failed list without holding progress while it retries", () => {
    const { status } = mountWith("reconnecting");
    expect(status()).toMatchObject({ isConnecting: false, error: null, summary });
    expect(usageEnvironmentProgress(status())).toEqual({ phase: "inactive" });
  });

  it("reports as not connected once no connection attempt runs", () => {
    const { status } = mountWith("offline");
    expect(status()).toMatchObject({
      isPending: false,
      error: "This environment is not connected. Totals include its last reported usage.",
      summary,
    });
    expect(usageEnvironmentProgress(status())).toEqual({ phase: "inactive" });
  });
});
