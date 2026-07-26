import { ResyncRequests } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  RESYNC_MIN_INTERVAL_MS,
  type ResyncScheduler,
  requestResync,
  resetResyncThrottleForTesting,
} from "./resyncRequests";

interface Harness {
  readonly scheduler: ResyncScheduler;
  /** Request a reconcile as if the clock read `nowMs`. */
  readonly requestAt: (nowMs: number) => void;
  /** Run every timer whose deadline has passed, advancing the clock to it. */
  readonly runDueTimers: () => void;
  readonly fired: () => number;
}

function harness(): { harness: Harness; dispose: () => void } {
  resetResyncThrottleForTesting();
  let fired = 0;
  const unsubscribe = ResyncRequests.onResyncRequested(() => {
    fired += 1;
  });
  let clock = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const scheduler: ResyncScheduler = {
    now: () => clock,
    setTimer: (run, delayMs) => {
      timers.push({ at: clock + delayMs, run });
    },
  };
  return {
    harness: {
      scheduler,
      requestAt: (nowMs) => {
        clock = nowMs;
        requestResync(scheduler);
      },
      runDueTimers: () => {
        const due = timers.splice(0, timers.length);
        for (const timer of due) {
          clock = timer.at;
          timer.run();
        }
      },
      fired: () => fired,
    },
    dispose: () => {
      unsubscribe();
      resetResyncThrottleForTesting();
    },
  };
}

function withHarness(run: (h: Harness) => void): number {
  const { harness: h, dispose } = harness();
  try {
    run(h);
    return h.fired();
  } finally {
    dispose();
  }
}

describe("requestResync", () => {
  it("passes the first request straight through", () => {
    expect(withHarness((h) => h.requestAt(0))).toBe(1);
  });

  it("coalesces a burst into one immediate reconcile", () => {
    // Settling many threads at once must not ask for the same snapshot fetch
    // and resubscribe once per thread.
    const fired = withHarness((h) => {
      for (let i = 0; i < 20; i += 1) {
        h.requestAt(i);
      }
    });
    expect(fired).toBe(1);
  });

  it("still reconciles for a request suppressed inside the window", () => {
    // The whole point of a request is that someone observed the client
    // disagreeing with the server. Dropping it would leave that standing.
    const fired = withHarness((h) => {
      h.requestAt(0);
      h.requestAt(100);
      expect(h.fired()).toBe(1);
      h.runDueTimers();
    });
    expect(fired).toBe(2);
  });

  it("collapses many suppressed requests into a single trailing reconcile", () => {
    const fired = withHarness((h) => {
      h.requestAt(0);
      for (let i = 1; i < 20; i += 1) {
        h.requestAt(i * 10);
      }
      h.runDueTimers();
    });
    expect(fired).toBe(2);
  });

  it("fires immediately once the window has passed", () => {
    const fired = withHarness((h) => {
      h.requestAt(0);
      h.requestAt(RESYNC_MIN_INTERVAL_MS);
    });
    expect(fired).toBe(2);
  });

  it("recovers from a backward clock jump instead of wedging shut", () => {
    // An NTP correction or manual clock change must not suppress every
    // reconcile until wall time catches back up to the old timestamp.
    const fired = withHarness((h) => {
      h.requestAt(1_000_000);
      h.requestAt(0);
    });
    expect(fired).toBe(2);
  });
});
