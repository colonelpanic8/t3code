import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import {
  type AdvertisedEndpoint,
  type AuthGrantScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopServerExposureState,
  type DesktopUpdateState,
  type DesktopWslState,
  type RunningLocalServer,
} from "@t3tools/contracts";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import * as Option from "effect/Option";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isLoopbackHostname } from "../../environments/primary/target";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import type { EnvironmentPresentation } from "../../state/environments";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

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

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The link a new pairing credential is shared as when no advertised endpoint
 * applies, or null to share the code alone. `pageUrl` is only passed for the
 * environment serving this page: a relay or SSH environment has no address
 * another device could open.
 */
export function resolveFallbackPairingUrl(input: {
  readonly credential: string;
  readonly endpointUrl: string | null | undefined;
  readonly pageUrl: string | null;
}): string | null {
  if (input.endpointUrl) {
    return (
      resolveHostedPairingUrl(input.endpointUrl, input.credential) ??
      resolveDesktopPairingUrl(input.endpointUrl, input.credential)
    );
  }
  if (input.pageUrl === null || isLoopbackUrl(input.pageUrl)) {
    return null;
  }
  return setPairingTokenOnUrl(new URL("/pair", input.pageUrl), input.credential).toString();
}

/**
 * Operating terminals without being able to list them leaves a client
 * allocating a fresh shell for every script run it cannot see, so the pairing
 * form keeps `terminal:read` alongside `terminal:operate`.
 */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export type LocalServerPairingStatus = "pair" | "pair-again" | "paired" | "version-mismatch";

export interface LocalServerPairingCandidate {
  readonly server: RunningLocalServer;
  readonly status: LocalServerPairingStatus;
}

/**
 * Discovered servers this client could pair with. This machine's own and
 * desktop-managed backends are never candidates. A saved environment is only
 * offered again once its connection has failed.
 */
export function selectLocalServerPairingCandidates(
  servers: ReadonlyArray<RunningLocalServer>,
  environments: ReadonlyArray<
    Pick<EnvironmentPresentation, "environmentId" | "entry" | "connection">
  >,
): ReadonlyArray<LocalServerPairingCandidate> {
  return servers.flatMap((server): LocalServerPairingCandidate[] => {
    const saved = environments.find(
      (environment) => environment.environmentId === server.environmentId,
    );
    if (
      saved?.entry.target._tag === "PrimaryConnectionTarget" ||
      (saved !== undefined && isDesktopLocalConnectionTarget(saved.entry.target))
    ) {
      return [];
    }
    const status: LocalServerPairingStatus =
      saved !== undefined && saved.connection.phase !== "error"
        ? "paired"
        : server.pairing === "version-mismatch"
          ? "version-mismatch"
          : saved !== undefined
            ? "pair-again"
            : "pair";
    return [{ server, status }];
  });
}

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

/**
 * Copy for the Tailscale HTTPS row when no Tailscale endpoint is advertised.
 * The desktop skips the Tailscale probe until Network access or Tailscale
 * Serve is on (it can trigger a macOS privacy prompt), so a missing endpoint
 * then means "not checked", not "not running".
 */
export function missingTailscaleEndpointDescription(
  state: Pick<DesktopServerExposureState, "mode" | "tailscaleServeEnabled"> | null,
): string {
  return state && state.mode !== "network-accessible" && !state.tailscaleServeEnabled
    ? "Turn on Network access to detect Tailscale."
    : "Start Tailscale to set up HTTPS access through MagicDNS.";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * Passive label for this machine's Version row once client and server versions
 * match. The desktop bundles its server, so a pending app update is the only
 * way it falls behind. Pending states follow the sidebar update control's
 * action, including retryable failures, so the two never disagree; the sidebar
 * is where to act. A recheck keeps a downloaded update while `checking`, so it
 * keeps its label too. `state` is null outside the desktop app.
 */
export function resolveLocalVersionStatusLabel(state: DesktopUpdateState | null): string {
  if (!state) return "Up to date";
  if (state.status === "downloading") {
    return state.availableVersion
      ? `Downloading update ${state.availableVersion}`
      : "Downloading update";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (
    action === "install" ||
    state.status === "downloaded" ||
    (state.status === "checking" && state.downloadedVersion !== null)
  ) {
    const version = getDesktopUpdateDownloadedVersion(state);
    return version ? `Update ${version} downloaded` : "Update downloaded";
  }
  if (action === "download") {
    return state.availableVersion
      ? `Update ${state.availableVersion} available`
      : "Update available";
  }
  return "Up to date";
}

export type QrEndpointOption = {
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  readonly qrShareable: boolean;
};

export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

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
