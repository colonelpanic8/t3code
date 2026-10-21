import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type DesktopWslState, type RunningLocalServer } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { getPairingTokenFromUrl } from "../../pairingUrl";
import {
  applyWslEnableSelection,
  isLoopbackUrl,
  resolveFallbackPairingUrl,
  selectLocalServerPairingCandidates,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";
describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});
describe("resolveFallbackPairingUrl", () => {
  it("shares only the code for an environment without an address another device can open", () => {
    expect(
      resolveFallbackPairingUrl({
        credential: "secret",
        endpointUrl: null,
        pageUrl: null,
      }),
    ).toBeNull();
  });
  it("falls back to this page's origin unless the page is loopback", () => {
    const url = resolveFallbackPairingUrl({
      credential: "secret",
      endpointUrl: undefined,
      pageUrl: "http://box.tail.ts.net:3773/settings/connections",
    });
    expect(url).not.toBeNull();
    expect(new URL(url!).origin + new URL(url!).pathname).toBe("http://box.tail.ts.net:3773/pair");
    expect(getPairingTokenFromUrl(new URL(url!))).toBe("secret");
    expect(
      resolveFallbackPairingUrl({
        credential: "secret",
        endpointUrl: undefined,
        pageUrl: "http://127.0.0.1:3773/settings/connections",
      }),
    ).toBeNull();
  });
  it("shares a loopback environment address as a link but never as a QR code", () => {
    const url = resolveFallbackPairingUrl({
      credential: "secret",
      endpointUrl: "http://127.0.0.1:3773/",
      pageUrl: null,
    });
    expect(url).not.toBeNull();
    expect(isLoopbackUrl(url!)).toBe(true);
  });
});
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
      return {
        ...baseWslState,
        distro,
        wslOnly: persistedWslOnly,
      };
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
      return {
        ...baseWslState,
        distro: persistedDistro,
        wslOnly: enabled,
      };
    });
    const state = await applyWslEnableSelection({
      bridge: {
        setWslDistro,
        setWslBackendEnabled,
        setWslOnly,
      },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });
    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({
      enabled: true,
      distro: "Debian",
      wslOnly: false,
    });
  });
});
describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];
  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });
  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});
describe("selectLocalServerPairingCandidates", () => {
  const server = {
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local server",
    httpBaseUrl: "http://127.0.0.1:3773/",
    pid: 1234,
    serverVersion: "0.0.1",
    pairing: "available",
  } satisfies RunningLocalServer;
  const savedEnvironment = (
    phase: "connected" | "reconnecting" | "error",
    target: ConnectionCatalogEntry["target"] = new BearerConnectionTarget({
      environmentId: server.environmentId,
      label: server.label,
      connectionId: `bearer:${server.environmentId}`,
    }),
  ) => ({
    environmentId: server.environmentId,
    entry: {
      target,
      profile: Option.none(),
      enabled: true,
    },
    connection: {
      phase,
      error: null,
      traceId: null,
    },
  });
  it("offers pairing again only once the saved connection has failed", () => {
    expect(selectLocalServerPairingCandidates([server], [])).toEqual([
      {
        server,
        status: "pair",
      },
    ]);
    expect(
      selectLocalServerPairingCandidates([server], [savedEnvironment("reconnecting")]),
    ).toEqual([
      {
        server,
        status: "paired",
      },
    ]);
    expect(selectLocalServerPairingCandidates([server], [savedEnvironment("error")])).toEqual([
      {
        server,
        status: "pair-again",
      },
    ]);
  });
  it("does not offer pairing with a server running a different version", () => {
    const mismatched = {
      ...server,
      pairing: "version-mismatch",
    } satisfies RunningLocalServer;
    expect(selectLocalServerPairingCandidates([mismatched], [])).toEqual([
      {
        server: mismatched,
        status: "version-mismatch",
      },
    ]);
  });
  it("never offers this machine's own environment", () => {
    const primary = savedEnvironment(
      "connected",
      new PrimaryConnectionTarget({
        environmentId: server.environmentId,
        label: server.label,
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    );
    expect(selectLocalServerPairingCandidates([server], [primary])).toEqual([]);
  });
});
