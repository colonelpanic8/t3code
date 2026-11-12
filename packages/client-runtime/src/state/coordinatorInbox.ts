import type {
  Coordinator,
  CoordinatorInboxItem,
  DefaultCoordinatorRef,
  EnvironmentId,
} from "@t3tools/contracts";

export interface CoordinatorChoice {
  readonly environmentId: EnvironmentId;
  readonly coordinator: Coordinator;
}

/**
 * The coordinator a client opens: the one it chose, while that still exists,
 * or the only one across its environments. Several and no choice: none, so
 * the client asks instead of guessing.
 */
export const resolveDefaultCoordinator = (
  chosen: DefaultCoordinatorRef | null,
  available: ReadonlyArray<CoordinatorChoice>,
): CoordinatorChoice | null => {
  if (chosen !== null) {
    const match = available.find(
      (choice) =>
        choice.environmentId === chosen.environmentId &&
        choice.coordinator.id === chosen.coordinatorId,
    );
    if (match !== undefined) return match;
  }
  return available.length === 1 ? available[0]! : null;
};

export interface CoordinatorInboxGroups {
  /** Questions, approvals, failures and notes. */
  readonly needsYou: ReadonlyArray<CoordinatorInboxItem>;
  /** Finished threads the user has not opened. */
  readonly finished: ReadonlyArray<CoordinatorInboxItem>;
}

export const groupCoordinatorInbox = (
  items: ReadonlyArray<CoordinatorInboxItem>,
): CoordinatorInboxGroups => ({
  needsYou: items.filter((item) => item.kind !== "unread"),
  finished: items.filter((item) => item.kind === "unread"),
});
