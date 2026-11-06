import { act, render, fakeTimers } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderInstanceId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { Atom } from "effect/reactivity";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
type Presentations = ReadonlyMap<EnvironmentId, Record<string, unknown>>;
const state = vi.hoisted(() => ({
  presentations: null as unknown as Atom.Writable<Presentations>,
  refreshProviders: vi.fn<(input: unknown) => Promise<undefined>>(),
  windows: [] as Array<{
    readonly sinceDay: string;
    readonly untilDay: string;
  }>,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
  useCanGoBack: () => false,
}));
// Real presentations come from live connections; these tests drive them directly.
vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const presentations = Atom.make<Presentations>(new Map()).pipe(Atom.keepAlive);
  state.presentations = presentations;
  const providers = Atom.make(
    (get) =>
      new Map(
        [...get(presentations)].map(([id, presentation]) => [
          id,
          (
            presentation.serverConfig as {
              providers: unknown;
            }
          ).providers,
        ]),
      ),
  );
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: presentations as never,
      presentationsWithProvidersAtom: presentations as never,
      providersByEnvironmentAtom: providers as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refreshProviders) as never,
}));
vi.mock(import("../../state/usage"), async (original) => {
  const environment = {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: null,
  };
  return {
    ...(await original()),
    useUsage: ((window: { readonly sinceDay: string; readonly untilDay: string }) => {
      state.windows.push(window);
      return {
        merged: mergeUsage([], USAGE_CONTRACT_VERSION),
        environments: [environment],
        selectedEnvironments: [environment],
        isPending: false,
        shown: null,
        isPartial: false,
        refresh: async () => undefined,
      };
    }) as never,
  };
});
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { UsagePage } from "./UsagePage";
const PREFERENCES_KEY = "t3code:usage-page-preferences:v1";
// Limits refreshes are throttled per environment for the whole session, so each test
// gets fresh environment ids.
let environmentNumber = 0;
let environmentId: EnvironmentId;
function presentation(phase = "connected") {
  return {
    entry: {
      target: {
        label: "Test",
      },
    },
    connection: {
      phase,
      error: null,
      traceId: null,
    },
    serverConfig: {
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: {
            status: "authenticated",
          },
          checkedAt: "2026-09-11T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-09-11T12:00:00Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 40,
                windowDurationMins: 300,
                resetsAt: "2026-09-11T14:00:00Z",
              },
            ],
          },
        },
      ],
    },
  };
}
const setPresentations = (entries: ReadonlyArray<readonly [EnvironmentId, object]>) =>
  act(async () => appAtomRegistry.set(state.presentations, new Map(entries) as Presentations));
async function renderPage({ strict = false } = {}) {
  const content = (
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsagePage />
    </RegistryContext.Provider>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}
async function setup() {
  // The metric toggle and its refresh button only show on wide screens.
  await page.viewport(1440, 900);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  environmentNumber += 1;
  environmentId = EnvironmentId.make(`test-${environmentNumber}`);
  const previous = localStorage.getItem(PREFERENCES_KEY);
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({
      metric: "limits",
      windowDays: 30,
    }),
  );
  state.refreshProviders.mockReset().mockResolvedValue(undefined);
  state.windows = [];
  await setPresentations([[environmentId, presentation()]]);
  return {
    [Symbol.dispose]() {
      now.mockRestore();
      if (previous === null) localStorage.removeItem(PREFERENCES_KEY);
      else localStorage.setItem(PREFERENCES_KEY, previous);
      appAtomRegistry.set(state.presentations, new Map());
    },
  };
}
it("asks for the new day's window when a page left open overnight comes back", async () => {
  using _state = await setup();
  // Days a full 24 hours apart differ in every time zone the browser may run in.
  const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
  using _timers = fakeTimers({
    now: Date.parse("2026-09-11T12:00:00Z"),
  });
  try {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        metric: "tokens",
        windowDays: 30,
      }),
    );
    await using _screen = await renderPage();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(state.windows.at(-1)?.untilDay).toBe(localDay("2026-09-11T12:00:00Z"));
    vi.setSystemTime(Date.parse("2026-09-12T12:00:00Z"));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(state.windows.at(-1)?.untilDay).toBe(localDay("2026-09-12T12:00:00Z"));
  } finally {
    vi.useRealTimers();
  }
});
