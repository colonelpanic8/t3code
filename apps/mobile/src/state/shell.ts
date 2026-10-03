import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make<EnvironmentShellState>({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
});

const environmentShellStateAtom = (environmentId: EnvironmentId | null) =>
  environmentId === null
    ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
    : environmentShell.stateValueAtom(environmentId);

const shellStatus = (state: EnvironmentShellState) => state.status;
const shellHasError = (state: EnvironmentShellState) => Option.isSome(state.error);
const shellError = (state: EnvironmentShellState) => Option.getOrNull(state.error);
const shellHasSnapshot = (state: EnvironmentShellState) => Option.isSome(state.snapshot);

/** Snapshot contents do not affect whether the route is still hydrating. */
export function useEnvironmentShellReadiness(environmentId: EnvironmentId | null) {
  const atom = environmentShellStateAtom(environmentId);
  return {
    status: useAtomValue(atom, shellStatus),
    hasError: useAtomValue(atom, shellHasError),
  };
}

/** Shell availability for one environment, without subscribing to snapshot contents. */
export function useEnvironmentShellAvailability(environmentId: EnvironmentId | null) {
  const atom = environmentShellStateAtom(environmentId);
  return {
    status: useAtomValue(atom, shellStatus),
    error: useAtomValue(atom, shellError),
    hasSnapshot: useAtomValue(atom, shellHasSnapshot),
  };
}
