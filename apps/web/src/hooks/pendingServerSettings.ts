import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

export interface PendingServerPatch {
  readonly id: number;
  readonly patch: ServerSettingsPatch;
  readonly baseSettings: ServerSettings;
  readonly settledSettings?: ServerSettings;
}

interface PendingServerState {
  readonly patches: ReadonlyArray<PendingServerPatch>;
  /** Latest successful RPC result, used to rebase the next queued write. */
  readonly authoritativeSettings: ServerSettings;
  /** Latest settings snapshot published to React, which may precede its RPC result. */
  readonly observedSettings: ServerSettings;
}

export const NO_PENDING_SERVER_PATCHES: ReadonlyArray<PendingServerPatch> = [];

const pendingByEnvironment = new Map<EnvironmentId, PendingServerState>();
const listeners = new Set<() => void>();
let nextPendingPatchId = 1;

function emitChange(): void {
  for (const listener of listeners) listener();
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Preserve only the provider-instance edits made by this operation when its
 * original optimistic base no longer matches the server after an earlier
 * write failed.
 */
export function rebaseServerSettingsPatch(
  patch: ServerSettingsPatch,
  originalBase: ServerSettings,
  currentBase: ServerSettings,
): ServerSettingsPatch {
  if (patch.providerInstances === undefined) return patch;

  const rebasedProviderInstances = { ...currentBase.providerInstances };
  const keys = new Set([
    ...Object.keys(originalBase.providerInstances),
    ...Object.keys(patch.providerInstances),
  ]);
  for (const key of keys) {
    const instanceId = key as keyof typeof patch.providerInstances;
    const previous = originalBase.providerInstances[instanceId];
    const next = patch.providerInstances[instanceId];
    if (structurallyEqual(previous, next)) continue;
    if (next === undefined) {
      delete rebasedProviderInstances[instanceId];
    } else {
      rebasedProviderInstances[instanceId] = next;
    }
  }
  return { ...patch, providerInstances: rebasedProviderInstances };
}

export function subscribePendingServerPatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingServerPatches(
  environmentId: EnvironmentId | null,
): ReadonlyArray<PendingServerPatch> {
  if (environmentId === null) return NO_PENDING_SERVER_PATCHES;
  return pendingByEnvironment.get(environmentId)?.patches ?? NO_PENDING_SERVER_PATCHES;
}

export function applyPendingServerPatches(
  settings: ServerSettings,
  patches: ReadonlyArray<PendingServerPatch>,
): ServerSettings {
  return patches.reduce((current, pending) => {
    const rebasedPatch = rebaseServerSettingsPatch(
      pending.patch,
      pending.baseSettings,
      current,
    );
    return applyServerSettingsPatch(current, rebasedPatch);
  }, settings);
}

export function retainPendingServerPatch(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
  baseSettings: ServerSettings,
  authoritativeSettings: ServerSettings,
): number {
  const existing = pendingByEnvironment.get(environmentId);
  const id = nextPendingPatchId++;
  pendingByEnvironment.set(environmentId, {
    patches: [...(existing?.patches ?? NO_PENDING_SERVER_PATCHES), { id, patch, baseSettings }],
    authoritativeSettings: existing?.authoritativeSettings ?? authoritativeSettings,
    observedSettings: existing?.observedSettings ?? authoritativeSettings,
  });
  emitChange();
  return id;
}

export function getPendingServerPatchForDispatch(
  environmentId: EnvironmentId,
  id: number,
): ServerSettingsPatch | null {
  const state = pendingByEnvironment.get(environmentId);
  const pending = state?.patches.find((entry) => entry.id === id);
  if (!state || !pending) return null;
  return rebaseServerSettingsPatch(
    pending.patch,
    pending.baseSettings,
    state.authoritativeSettings,
  );
}

export function settlePendingServerPatch(
  environmentId: EnvironmentId,
  id: number,
  settings: ServerSettings | null,
): void {
  const state = pendingByEnvironment.get(environmentId);
  if (!state) return;
  const settledIndex = state.patches.findIndex((entry) => entry.id === id);
  const settingsWereAlreadyObserved =
    settings !== null &&
    settledIndex >= 0 &&
    structurallyEqual(state.observedSettings, settings);
  const patches =
    settings === null
      ? state.patches.filter((entry) => entry.id !== id)
      : settingsWereAlreadyObserved
        ? state.patches.slice(settledIndex + 1)
        : state.patches.map((entry) =>
            entry.id === id ? { ...entry, settledSettings: settings } : entry,
          );
  if (patches.length === 0) {
    pendingByEnvironment.delete(environmentId);
  } else {
    pendingByEnvironment.set(environmentId, {
      patches,
      authoritativeSettings: settings ?? state.authoritativeSettings,
      observedSettings: state.observedSettings,
    });
  }
  emitChange();
}

/**
 * Retire successful overlays only when their actual settingsUpdated payload is
 * observed. An initial config snapshot cannot acknowledge a write accidentally.
 */
export function acknowledgePendingServerSettings(
  environmentId: EnvironmentId,
  settings: ServerSettings,
): void {
  const state = pendingByEnvironment.get(environmentId);
  if (!state) return;
  const acknowledgedIndex = state.patches.findLastIndex(
    (entry) =>
      entry.settledSettings !== undefined && structurallyEqual(entry.settledSettings, settings),
  );
  if (acknowledgedIndex >= 0) {
    const patches = state.patches.slice(acknowledgedIndex + 1);
    if (patches.length === 0) {
      pendingByEnvironment.delete(environmentId);
    } else {
      pendingByEnvironment.set(environmentId, {
        patches,
        authoritativeSettings: settings,
        observedSettings: settings,
      });
    }
    emitChange();
    return;
  }
  pendingByEnvironment.set(environmentId, {
    ...state,
    ...(state.patches.some((entry) => entry.settledSettings !== undefined)
      ? {}
      : { authoritativeSettings: settings }),
    observedSettings: settings,
  });
}

export function __resetPendingServerPatchesForTests(): void {
  pendingByEnvironment.clear();
  listeners.clear();
  nextPendingPatchId = 1;
}
