import { ResyncRequests } from "@t3tools/client-runtime/connection";

/**
 * Coalescing wrapper around the shared resync signal.
 *
 * A reconcile costs a snapshot fetch and a resubscribe, and the callers that
 * need one arrive in bursts — settling twenty threads at once would otherwise
 * ask twenty times for work that a single reconcile already covers for the
 * whole environment.
 */

/** Minimum spacing between reconciles. */
export const RESYNC_MIN_INTERVAL_MS = 5_000;

let lastRequestAtMs: number | null = null;

/** Request a reconcile, dropping anything inside the coalescing window. */
export function requestResync(nowMs: number = Date.now()): void {
  if (lastRequestAtMs !== null && nowMs - lastRequestAtMs < RESYNC_MIN_INTERVAL_MS) {
    return;
  }
  lastRequestAtMs = nowMs;
  ResyncRequests.requestResync();
}

/** Test seam: forget the coalescing window. */
export function resetResyncThrottleForTesting(): void {
  lastRequestAtMs = null;
}
