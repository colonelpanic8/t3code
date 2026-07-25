import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DesktopWslState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  environmentPairingBaseUrl,
  resolveAccessEnvironment,
} from "./ConnectionsSettings.logic";

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

const primaryId = EnvironmentId.make("primary-env");
const savedId = EnvironmentId.make("saved-env");

describe("resolveAccessEnvironment", () => {
  it("administers the managed backend when one exists, even while viewing a saved environment", () => {
    expect(
      resolveAccessEnvironment({
        primaryEnvironmentId: primaryId,
        activeEnvironmentId: savedId,
      }),
    ).toEqual({ environmentId: primaryId, isPrimary: true });
  });

  it("administers the selected environment when there is no managed backend", () => {
    expect(
      resolveAccessEnvironment({
        primaryEnvironmentId: null,
        activeEnvironmentId: savedId,
      }),
    ).toEqual({ environmentId: savedId, isPrimary: false });
  });

  it("has nothing to administer when no environment is selected either", () => {
    expect(
      resolveAccessEnvironment({ primaryEnvironmentId: null, activeEnvironmentId: null }),
    ).toEqual({ environmentId: null, isPrimary: false });
  });
});

describe("environmentPairingBaseUrl", () => {
  const entry = (
    target: ConnectionCatalogEntry["target"],
    profile?: unknown,
  ): ConnectionCatalogEntry => ({
    target,
    profile: (profile === undefined
      ? Option.none()
      : Option.some(profile)) as ConnectionCatalogEntry["profile"],
  });

  it("uses a bearer environment's own base URL", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new BearerConnectionTarget({
            environmentId: savedId,
            label: "headless",
            connectionId: "bearer:saved-env",
          }),
          new BearerConnectionProfile({
            connectionId: "bearer:saved-env",
            environmentId: savedId,
            label: "headless",
            httpBaseUrl: "https://box.tail.ts.net/",
            wsBaseUrl: "wss://box.tail.ts.net/",
          }),
        ),
      ),
    ).toBe("https://box.tail.ts.net/");
  });

  it("uses the primary's base URL", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new PrimaryConnectionTarget({
            environmentId: primaryId,
            label: "local",
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
          }),
        ),
      ),
    ).toBe("http://127.0.0.1:3773/");
  });

  it("has no shareable URL for a bearer environment whose profile is missing", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new BearerConnectionTarget({
            environmentId: savedId,
            label: "headless",
            connectionId: "bearer:saved-env",
          }),
        ),
      ),
    ).toBeNull();
  });

  it("has no shareable URL for an SSH tunnel, whose local address is meaningless elsewhere", () => {
    expect(
      environmentPairingBaseUrl(
        entry(
          new SshConnectionTarget({
            environmentId: savedId,
            label: "box",
            connectionId: "ssh:box",
          }),
          new SshConnectionProfile({
            connectionId: "ssh:box",
            environmentId: savedId,
            label: "box",
            target: { alias: "box", hostname: "box", username: "ivan", port: 22 },
          }),
        ),
      ),
    ).toBeNull();
  });

  it("has no shareable URL for a relay environment", () => {
    expect(
      environmentPairingBaseUrl(
        entry(new RelayConnectionTarget({ environmentId: savedId, label: "cloud" })),
      ),
    ).toBeNull();
  });
});
