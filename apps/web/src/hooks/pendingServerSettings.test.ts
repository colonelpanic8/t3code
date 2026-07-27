import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetPendingServerPatchesForTests,
  applyPendingServerPatches,
  getPendingServerPatches,
  releasePendingServerPatch,
  retainPendingServerPatch,
  subscribePendingServerPatches,
} from "./pendingServerSettings";

const environmentId = EnvironmentId.make("environment-1");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

const providerInstance = (driver: string, enabled: boolean) => ({
  driver: ProviderDriverKind.make(driver),
  enabled,
});

afterEach(() => {
  __resetPendingServerPatchesForTests();
});

describe("pendingServerSettings", () => {
  it("has no overlay before a write is dispatched", () => {
    expect(getPendingServerPatches(environmentId)).toEqual([]);
    expect(getPendingServerPatches(null)).toEqual([]);
    expect(applyPendingServerPatches(DEFAULT_SERVER_SETTINGS, [])).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("keeps a second provider toggle from reverting the first one", () => {
    // Disabling codex is dispatched from the server's own (empty) map.
    const disableCodex = {
      providerInstances: { [codexId]: providerInstance("codex", false) },
    };
    retainPendingServerPatch(environmentId, disableCodex);

    // Before the echo lands, the panel must already see codex disabled so the
    // next whole-map replacement it builds carries that edit forward.
    const optimistic = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(optimistic.providerInstances[codexId]?.enabled).toBe(false);

    const disableClaude = {
      providerInstances: {
        ...optimistic.providerInstances,
        [claudeId]: providerInstance("claudeAgent", false),
      },
    };
    retainPendingServerPatch(environmentId, disableClaude);

    const both = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(both.providerInstances[codexId]?.enabled).toBe(false);
    expect(both.providerInstances[claudeId]?.enabled).toBe(false);
  });

  it("retains the overlay until the last outstanding write settles", () => {
    const patch = { providerInstances: { [codexId]: providerInstance("codex", false) } };
    retainPendingServerPatch(environmentId, patch);
    retainPendingServerPatch(environmentId, patch);

    releasePendingServerPatch(environmentId);
    expect(getPendingServerPatches(environmentId)).toHaveLength(2);

    releasePendingServerPatch(environmentId);
    expect(getPendingServerPatches(environmentId)).toEqual([]);
  });

  it("drops the overlay for a failed write so the server value wins again", () => {
    retainPendingServerPatch(environmentId, {
      providerInstances: { [codexId]: providerInstance("codex", false) },
    });
    releasePendingServerPatch(environmentId);

    const settings = applyPendingServerPatches(
      DEFAULT_SERVER_SETTINGS,
      getPendingServerPatches(environmentId),
    );
    expect(settings).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("scopes pending writes to their own environment", () => {
    const otherEnvironmentId = EnvironmentId.make("environment-2");
    retainPendingServerPatch(environmentId, {
      providerInstances: { [codexId]: providerInstance("codex", false) },
    });

    expect(getPendingServerPatches(otherEnvironmentId)).toEqual([]);
    releasePendingServerPatch(otherEnvironmentId);
    expect(getPendingServerPatches(environmentId)).toHaveLength(1);
  });

  it("notifies subscribers when the pending set changes", () => {
    let notifications = 0;
    const unsubscribe = subscribePendingServerPatches(() => {
      notifications += 1;
    });

    retainPendingServerPatch(environmentId, { enableAssistantStreaming: false });
    releasePendingServerPatch(environmentId);
    unsubscribe();
    retainPendingServerPatch(environmentId, { enableAssistantStreaming: false });

    expect(notifications).toBe(2);
  });
});
