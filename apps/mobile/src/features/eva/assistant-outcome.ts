import type { AssistantRequestUpdate } from "./assistant-requests";

// States the native journal stores. See ReceiptState in the native module.
export type AssistantRequestState =
  | "accepted"
  | "waiting_for_host"
  | "submitted"
  | "completed"
  | "failed"
  | "uncertain"
  | "rejected"
  | "needs_configuration"
  | "needs_host_update";

const MAX_ERROR_MESSAGE = 500;

/** Ends a request at the state it carries; thrown by planning, caught by the runner. */
export class Outcome extends Error {
  constructor(readonly update: AssistantRequestUpdate) {
    super(update.error?.message ?? update.state ?? "outcome");
  }
}

export function clip(message: string): string {
  const chars = Array.from(message);
  return chars.length > MAX_ERROR_MESSAGE ? chars.slice(0, MAX_ERROR_MESSAGE).join("") : message;
}

export function stop(state: AssistantRequestState, code: string, message: string): Outcome {
  return new Outcome({ state, error: { code, message: clip(message) } });
}

/** Nothing needs sending: the thread is already as asked. */
export function done(summary: string): Outcome {
  return new Outcome({ state: "completed", summary: clip(summary) });
}
