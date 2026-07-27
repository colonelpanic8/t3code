/**
 * Optimistic overlay for server settings writes that are still in flight.
 *
 * Server settings only change locally once the server echoes a
 * `settingsUpdated` broadcast back over the websocket. Until that round trip
 * lands, readers still see pre-edit settings, so a second edit issued inside
 * the window is computed from stale state — and because keys such as
 * `providerInstances` are whole-value replacements rather than deep merges,
 * that second write silently reverts the first one. (Toggle one provider off,
 * toggle a second off a moment later, and the first provider's switch snaps
 * back on once its own write is overwritten.)
 *
 * Each in-flight patch is retained here and replayed on top of the server value
 * through the same `applyServerSettingsPatch` the server runs, so both reads and
 * follow-up patches are built from the edit the user just made. Retained patches
 * are dropped once no write is outstanding for that environment, at which point
 * the server value is authoritative again — including when a write failed.
 *
 * @module hooks/pendingServerSettings
 */
import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

interface PendingServerPatches {
  readonly patches: ReadonlyArray<ServerSettingsPatch>;
  /** Writes dispatched for this environment that have not settled yet. */
  readonly inFlight: number;
}

export const NO_PENDING_SERVER_PATCHES: ReadonlyArray<ServerSettingsPatch> = [];

const pendingByEnvironment = new Map<EnvironmentId, PendingServerPatches>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePendingServerPatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Snapshot accessor for `useSyncExternalStore`: the returned array is stable
 * until the environment's pending set actually changes.
 */
export function getPendingServerPatches(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ServerSettingsPatch> {
  if (environmentId === null) return NO_PENDING_SERVER_PATCHES;
  return pendingByEnvironment.get(environmentId)?.patches ?? NO_PENDING_SERVER_PATCHES;
}

/** Record a patch that has just been dispatched to the server. */
export function retainPendingServerPatch(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): void {
  const pending = pendingByEnvironment.get(environmentId);
  pendingByEnvironment.set(environmentId, {
    patches: [...(pending?.patches ?? NO_PENDING_SERVER_PATCHES), patch],
    inFlight: (pending?.inFlight ?? 0) + 1,
  });
  emitChange();
}

/**
 * Mark one dispatched write as settled. Patches are only forgotten when the
 * last outstanding write settles: releasing them one at a time would expose the
 * server value before its later echo arrived, flickering the UI back to a state
 * the user has already edited away from.
 */
export function releasePendingServerPatch(environmentId: EnvironmentId): void {
  const pending = pendingByEnvironment.get(environmentId);
  if (pending === undefined) return;
  if (pending.inFlight <= 1) {
    pendingByEnvironment.delete(environmentId);
  } else {
    pendingByEnvironment.set(environmentId, {
      patches: pending.patches,
      inFlight: pending.inFlight - 1,
    });
  }
  emitChange();
}

/** Replay in-flight patches over an authoritative server settings value. */
export function applyPendingServerPatches(
  settings: ServerSettings,
  patches: ReadonlyArray<ServerSettingsPatch>,
): ServerSettings {
  if (patches.length === 0) return settings;
  return patches.reduce<ServerSettings>(
    (current, patch) => applyServerSettingsPatch(current, patch),
    settings,
  );
}

export function __resetPendingServerPatchesForTests(): void {
  pendingByEnvironment.clear();
  listeners.clear();
}
