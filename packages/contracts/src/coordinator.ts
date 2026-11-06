import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { CoordinatorId } from "./coordinatorConfig.ts";
import { OrchestratorMcpEnvironmentTarget } from "./orchestratorMcp.ts";

export * from "./coordinatorConfig.ts";

export const Coordinator = Schema.Struct({
  id: CoordinatorId,
  name: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  wakeEveryMinutes: Schema.NullOr(Schema.Int),
  /** Why the coordinator's project or thread could not be set up. */
  error: Schema.NullOr(Schema.String),
});
export type Coordinator = typeof Coordinator.Type;

export const CoordinatorListResult = Schema.Struct({
  coordinators: Schema.Array(Coordinator),
});
export type CoordinatorListResult = typeof CoordinatorListResult.Type;

export const CoordinatorInboxItemKind = Schema.Literals([
  "question",
  "approval",
  "failed",
  "unread",
  "note",
]);
export type CoordinatorInboxItemKind = typeof CoordinatorInboxItemKind.Type;

export const CoordinatorInboxThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type CoordinatorInboxThreadRef = typeof CoordinatorInboxThreadRef.Type;

export const CoordinatorInboxItem = Schema.Struct({
  /** Stable while the item stands: the same thread and kind, or the same note. */
  id: TrimmedNonEmptyString,
  kind: CoordinatorInboxItemKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  thread: Schema.NullOr(CoordinatorInboxThreadRef),
  /** The environment's label, for items about a thread. */
  environmentLabel: Schema.NullOr(Schema.String),
  since: IsoDateTime,
});
export type CoordinatorInboxItem = typeof CoordinatorInboxItem.Type;

export const CoordinatorInboxSource = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** `unreachable`: its items are from the last answer, or missing. */
  status: Schema.Literals(["ok", "unreachable"]),
  error: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type CoordinatorInboxSource = typeof CoordinatorInboxSource.Type;

export const CoordinatorInbox = Schema.Struct({
  coordinatorId: CoordinatorId,
  items: Schema.Array(CoordinatorInboxItem),
  sources: Schema.Array(CoordinatorInboxSource),
});
export type CoordinatorInbox = typeof CoordinatorInbox.Type;

export const CoordinatorInboxSubscribeInput = Schema.Struct({ coordinatorId: CoordinatorId });
export type CoordinatorInboxSubscribeInput = typeof CoordinatorInboxSubscribeInput.Type;

export const CoordinatorInboxDismissInput = Schema.Struct({
  coordinatorId: CoordinatorId,
  itemId: TrimmedNonEmptyString,
});
export type CoordinatorInboxDismissInput = typeof CoordinatorInboxDismissInput.Type;

export class CoordinatorError extends Schema.TaggedError<CoordinatorError>()("CoordinatorError", {
  message: Schema.String,
}) {}

export const CoordinatorInboxToolInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals(["list", "post", "resolve", "local"]).annotate({
    description:
      "list: the coordinator's inbox across linked environments. post: add a note for the user. resolve: remove a note by `itemId`. local: this environment's own items.",
  }),
  coordinatorId: Schema.optional(CoordinatorId).annotate({
    description: "Omit inside a coordinator's thread, or when the environment has one.",
  }),
  title: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedString),
  thread: Schema.optional(CoordinatorInboxThreadRef).annotate({
    description: "The thread a note is about.",
  }),
  itemId: Schema.optional(TrimmedNonEmptyString),
});
export type CoordinatorInboxToolInput = typeof CoordinatorInboxToolInput.Type;

export const CoordinatorInboxToolResult = Schema.Struct({
  items: Schema.Array(CoordinatorInboxItem),
  sources: Schema.optional(Schema.Array(CoordinatorInboxSource)),
  posted: Schema.optional(CoordinatorInboxItem),
});
export type CoordinatorInboxToolResult = typeof CoordinatorInboxToolResult.Type;
