import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export function diagnosticsConnectionNotice(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly label: string;
  readonly error: string | null;
}): string | null {
  switch (input.phase) {
    case "connected":
      return null;
    case "connecting":
      return `Connecting to ${input.label}...`;
    case "reconnecting":
      return input.error
        ? `Reconnecting to ${input.label}... Reason: ${input.error}`
        : `Reconnecting to ${input.label}...`;
    case "offline":
      return `${input.label} is offline. Diagnostics load once it reconnects.`;
    case "available":
      return `${input.label} is not connected. Diagnostics load once it connects.`;
    case "error":
      return input.error
        ? `Could not connect to ${input.label}. Reason: ${input.error}`
        : `Could not connect to ${input.label}.`;
  }
}

export interface PendingProcessSignal {
  readonly environmentId: EnvironmentId;
  readonly pid: number;
}

export function addPendingProcessSignal(
  pending: ReadonlyArray<PendingProcessSignal>,
  signal: PendingProcessSignal,
): ReadonlyArray<PendingProcessSignal> {
  return pending.some(
    (entry) => entry.environmentId === signal.environmentId && entry.pid === signal.pid,
  )
    ? pending
    : [...pending, signal];
}

export function removePendingProcessSignal(
  pending: ReadonlyArray<PendingProcessSignal>,
  signal: PendingProcessSignal,
): ReadonlyArray<PendingProcessSignal> {
  return pending.filter(
    (entry) => entry.environmentId !== signal.environmentId || entry.pid !== signal.pid,
  );
}

export function pendingProcessSignalPids(
  pending: ReadonlyArray<PendingProcessSignal>,
  environmentId: EnvironmentId | null,
): ReadonlySet<number> {
  return new Set(
    pending
      .filter((entry) => environmentId !== null && entry.environmentId === environmentId)
      .map((entry) => entry.pid),
  );
}
