import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  getVoiceLiveState,
  subscribeVoiceLiveState,
  type VoiceLiveState,
} from "./voiceLiveStore";

export function useVoiceLiveState(): VoiceLiveState {
  return useSyncExternalStore(subscribeVoiceLiveState, getVoiceLiveState);
}

export interface VoiceLiveTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Connected environments that can host a Live Voice call. Absent capability
 * means unsupported (older server) — never probe, just hide the launcher.
 */
export function useVoiceLiveTargets(): ReadonlyArray<VoiceLiveTarget> {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            configs.get(environment.environmentId)?.environment.capabilities.voiceLive === true,
        )
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
        })),
    [configs, environments],
  );
}
