import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The comparison the UI uses to decide whether an environment is "remote" —
 * i.e. somewhere other than the machine this app runs its own backend on.
 */
export type EnvironmentPresenceScope =
  | {
      /** This app owns a backend whose environment may still be registering. */
      readonly kind: "local-owner";
      readonly localEnvironmentId: EnvironmentId | null;
    }
  | {
      /**
       * A client-only desktop or hosted static app has no local environment.
       * Every environment it can reach is remote; there is deliberately no
       * "primary environment" field in this state.
       */
      readonly kind: "remote-client";
    };

export function runtimeOwnsLocalEnvironment(input: {
  readonly hasDesktopBridge: boolean;
  readonly desktopClientOnlyMode: boolean;
}): boolean {
  return input.hasDesktopBridge && !input.desktopClientOnlyMode;
}

export function isRemoteEnvironmentId(
  environmentId: EnvironmentId,
  scope: EnvironmentPresenceScope,
): boolean {
  if (scope.kind === "remote-client") {
    return true;
  }
  return scope.localEnvironmentId !== null && environmentId !== scope.localEnvironmentId;
}
