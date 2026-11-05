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

/** The part of a journal update that ends a request without dispatching it. */
export interface OutcomeUpdate {
  readonly state: AssistantRequestState;
  readonly environmentName?: string;
  readonly summary?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Ends a request at the state it carries; thrown by planning, caught by the runner. */
export class Outcome extends Error {
  constructor(readonly update: OutcomeUpdate) {
    super(update.error?.message ?? update.state);
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
