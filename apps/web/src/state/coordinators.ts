import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveDefaultCoordinator,
  type CoordinatorChoice,
} from "@t3tools/client-runtime/state/coordinator-inbox";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations, environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

const coordinatorChoicesAtom = Atom.make((get) => {
  const configs = get(environmentPresentations.serverConfigsAtom);
  const next: CoordinatorChoice[] = [];
  for (const environmentId of get(environmentSummaries.connectedEnvironmentIdsAtom)) {
    if (configs.get(environmentId)?.environment.capabilities.coordinators !== true) continue;
    const result = get(serverEnvironment.coordinatorsLive({ environmentId, input: {} }));
    for (const coordinator of AsyncResult.getOrElse(result, () => null)?.coordinators ?? []) {
      next.push({ environmentId, coordinator });
    }
  }
  const previous = Option.getOrNull(get.self<ReadonlyArray<CoordinatorChoice>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every(
      (choice, index) =>
        choice.environmentId === previous[index]?.environmentId &&
        choice.coordinator === previous[index]?.coordinator,
    )
    ? previous
    : next;
}).pipe(Atom.withLabel("web-coordinator-choices"));

/** Coordinators across connected environments that serve them. */
export function useCoordinatorChoices(): ReadonlyArray<CoordinatorChoice> {
  return useAtomValue(coordinatorChoicesAtom);
}

export function useDefaultCoordinator(): CoordinatorChoice | null {
  const chosen = useClientSettings((settings) => settings.defaultCoordinator);
  return resolveDefaultCoordinator(chosen, useCoordinatorChoices());
}

export function coordinatorThreadRef(choice: CoordinatorChoice): ScopedThreadRef | null {
  return choice.coordinator.threadId === null
    ? null
    : scopeThreadRef(choice.environmentId, choice.coordinator.threadId);
}

/** For shortcut handlers, which run outside React. */
export function readDefaultCoordinator(): CoordinatorChoice | null {
  return resolveDefaultCoordinator(
    getClientSettings().defaultCoordinator,
    appAtomRegistry.get(coordinatorChoicesAtom),
  );
}
