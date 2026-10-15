import { FleetMembership, type PendingFleetMember } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "./runtime";

const pendingFleetMembersAtom = connectionAtomRuntime.atom(
  Stream.unwrap(
    FleetMembership.pipe(Effect.map((fleet) => SubscriptionRef.changes(fleet.pending))),
  ),
  { initialValue: [] as ReadonlyArray<PendingFleetMember> },
);

/** Fleet machines this device has not joined yet. Members moving to a new URL keep their saved row. */
export const pendingFleetJoinsAtom = Atom.make((get) =>
  Option.getOrElse(AsyncResult.value(get(pendingFleetMembersAtom)), () => []).filter(
    (member) => member.kind === "join",
  ),
).pipe(Atom.withLabel("mobile:pending-fleet-joins"));

export const retryPendingFleetMembers = createRuntimeCommand(connectionAtomRuntime, {
  label: "fleet:retry-pending",
  concurrency: { mode: "serial", key: () => "fleet-retry" },
  execute: () => FleetMembership.pipe(Effect.flatMap((fleet) => fleet.retry)),
});
