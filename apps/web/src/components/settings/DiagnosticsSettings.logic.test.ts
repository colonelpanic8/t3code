import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPendingProcessSignal,
  diagnosticsConnectionNotice,
  pendingProcessSignalPids,
  removePendingProcessSignal,
} from "./DiagnosticsSettings.logic";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

describe("diagnosticsConnectionNotice", () => {
  it("allows queries only while connected", () => {
    expect(
      diagnosticsConnectionNotice({ phase: "connected", label: "Laptop", error: null }),
    ).toBeNull();
    expect(diagnosticsConnectionNotice({ phase: "offline", label: "Laptop", error: null })).toBe(
      "Laptop is offline. Diagnostics load once it reconnects.",
    );
  });

  it("includes reconnect errors", () => {
    expect(
      diagnosticsConnectionNotice({
        phase: "reconnecting",
        label: "Laptop",
        error: "socket hang up",
      }),
    ).toBe("Reconnecting to Laptop... Reason: socket hang up");
  });
});

describe("pending process signals", () => {
  it("tracks the same pid independently per environment", () => {
    const pending = addPendingProcessSignal(
      addPendingProcessSignal([], { environmentId: PRIMARY, pid: 100 }),
      { environmentId: REMOTE, pid: 100 },
    );

    expect([...pendingProcessSignalPids(pending, PRIMARY)]).toEqual([100]);
    expect([...pendingProcessSignalPids(pending, REMOTE)]).toEqual([100]);
    expect(
      pendingProcessSignalPids(
        removePendingProcessSignal(pending, { environmentId: PRIMARY, pid: 100 }),
        PRIMARY,
      ).size,
    ).toBe(0);
  });
});
