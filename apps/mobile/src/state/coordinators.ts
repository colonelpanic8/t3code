import { useAtomValue } from "@effect/atom-react";
import {
  resolveDefaultCoordinator,
  type CoordinatorChoice,
} from "@t3tools/client-runtime/state/coordinator-inbox";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

const coordinatorEnvironmentIdsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  const next = get(connectedEnvironmentIdsAtom).filter(
    (id) => configs.get(id)?.environment.capabilities.coordinators === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("mobile:coordinator-environment-ids"));

export const coordinatorsAvailableAtom = Atom.make(
  (get) => get(coordinatorEnvironmentIdsAtom).length > 0,
).pipe(Atom.withLabel("mobile:coordinators-available"));

/** Every coordinator across connected environments; reading it subscribes to each list. */
export const coordinatorChoicesAtom = Atom.make((get): ReadonlyArray<CoordinatorChoice> =>
  get(coordinatorEnvironmentIdsAtom).flatMap((environmentId) => {
    const list = AsyncResult.getOrElse(
      get(serverEnvironment.coordinatorsLive({ environmentId, input: {} })),
      () => null,
    );
    return (list?.coordinators ?? []).map((coordinator) => ({ environmentId, coordinator }));
  }),
).pipe(Atom.withLabel("mobile:coordinator-choices"));

export function useCoordinatorChoices() {
  const choices = useAtomValue(coordinatorChoicesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const chosen = AsyncResult.isSuccess(preferences)
    ? (preferences.value.defaultCoordinator ?? null)
    : null;
  return { choices, chosen, resolved: resolveDefaultCoordinator(chosen, choices) };
}
