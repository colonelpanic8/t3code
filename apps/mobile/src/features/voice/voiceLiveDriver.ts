import {
  createVoiceLiveCallDriver,
  voiceLiveHostsFromPresentations,
  type VoiceLiveCallCallbacks,
  type VoiceLiveCallHandle,
} from "@t3tools/client-runtime/state/voice-live";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";

/**
 * Mobile wiring for the shared Live Voice call driver: binds it to the app's
 * connection runtime/atom registry and answers the driver's `list_hosts`
 * snapshots from the environment presentations (sanitized label + status
 * only; endpoints and credentials never cross the route).
 */

const driver = createVoiceLiveCallDriver(connectionAtomRuntime);

export type { VoiceLiveCallCallbacks, VoiceLiveCallHandle };

export function startVoiceLiveDriverCall(
  input: {
    readonly environmentId: EnvironmentId;
    readonly offerSdp: string;
    readonly voice?: string;
    readonly crossHostRouting: boolean;
  },
  callbacks: VoiceLiveCallCallbacks,
): VoiceLiveCallHandle {
  return driver.startVoiceLiveCall(
    appAtomRegistry,
    {
      ...input,
      listHosts: () =>
        voiceLiveHostsFromPresentations(
          appAtomRegistry.get(environmentPresentations.presentationsAtom),
        ),
    },
    callbacks,
  );
}
