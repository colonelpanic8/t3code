import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { DesktopBridge, DesktopWslState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

/**
 * Pick the server whose pairing links and client sessions the Connections page
 * administers.
 *
 * A desktop that manages its own backend keeps administering that backend, so
 * managed mode is unchanged. A client-only desktop — or a browser pointed at a
 * saved server — has no primary, and administers the selected environment
 * instead. Access management was previously reachable only through the primary,
 * which left those clients with no way to mint a pairing link at all.
 */
export function resolveAccessEnvironment(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
}): { readonly environmentId: EnvironmentId | null; readonly isPrimary: boolean } {
  const environmentId = input.primaryEnvironmentId ?? input.activeEnvironmentId;
  return {
    environmentId,
    isPrimary: environmentId !== null && environmentId === input.primaryEnvironmentId,
  };
}

/**
 * The address to build a shareable pairing URL from for an environment the
 * desktop does not manage. Only a directly addressable HTTP origin is usable:
 * relay and SSH environments are reached through a broker or a local tunnel
 * whose address means nothing on another device, so those fall back to showing
 * the bare pairing code instead of an unusable link.
 */
export function environmentPairingBaseUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "RelayConnectionTarget":
    case "SshConnectionTarget":
      return null;
  }
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
