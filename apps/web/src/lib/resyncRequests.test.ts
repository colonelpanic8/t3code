import { ResyncRequests } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  RESYNC_MIN_INTERVAL_MS,
  requestResync,
  resetResyncThrottleForTesting,
} from "./resyncRequests";

function countRequests(run: (notify: (nowMs: number) => void) => void): number {
  resetResyncThrottleForTesting();
  let seen = 0;
  const unsubscribe = ResyncRequests.onResyncRequested(() => {
    seen += 1;
  });
  try {
    run(requestResync);
  } finally {
    unsubscribe();
    resetResyncThrottleForTesting();
  }
  return seen;
}

describe("requestResync", () => {
  it("passes a request through to subscribers", () => {
    expect(countRequests((notify) => notify(0))).toBe(1);
  });

  it("coalesces a burst into one reconcile", () => {
    // Settling many threads at once must not ask for the same snapshot fetch
    // and resubscribe once per thread.
    const seen = countRequests((notify) => {
      for (let i = 0; i < 20; i += 1) {
        notify(i);
      }
    });
    expect(seen).toBe(1);
  });

  it("allows another reconcile once the window has passed", () => {
    const seen = countRequests((notify) => {
      notify(0);
      notify(RESYNC_MIN_INTERVAL_MS - 1);
      notify(RESYNC_MIN_INTERVAL_MS);
    });
    expect(seen).toBe(2);
  });
});
