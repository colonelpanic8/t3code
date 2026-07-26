import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isRemoteEnvironmentId, runtimeOwnsLocalEnvironment } from "./environmentPresence";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");

describe("isRemoteEnvironmentId", () => {
  it("treats the primary environment as local and everything else as remote", () => {
    const scope = {
      kind: "local-owner",
      localEnvironmentId: primaryEnvironmentId,
    } as const;

    expect(isRemoteEnvironmentId(primaryEnvironmentId, scope)).toBe(false);
    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(true);
  });

  it("treats every environment as remote when the app owns no local backend", () => {
    const scope = { kind: "remote-client" } as const;

    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(true);
    expect(isRemoteEnvironmentId(primaryEnvironmentId, scope)).toBe(true);
  });

  it("treats nothing as remote while a managed app's primary is still registering", () => {
    const scope = { kind: "local-owner", localEnvironmentId: null } as const;

    expect(isRemoteEnvironmentId(remoteEnvironmentId, scope)).toBe(false);
  });
});

describe("runtimeOwnsLocalEnvironment", () => {
  it("only lets a managed desktop runtime own a local environment", () => {
    expect(
      runtimeOwnsLocalEnvironment({
        hasDesktopBridge: true,
        desktopClientOnlyMode: false,
      }),
    ).toBe(true);
    expect(
      runtimeOwnsLocalEnvironment({
        hasDesktopBridge: true,
        desktopClientOnlyMode: true,
      }),
    ).toBe(false);
  });

  it("treats a server-hosted browser as a remote client", () => {
    expect(
      runtimeOwnsLocalEnvironment({
        hasDesktopBridge: false,
        desktopClientOnlyMode: false,
      }),
    ).toBe(false);
  });
});
