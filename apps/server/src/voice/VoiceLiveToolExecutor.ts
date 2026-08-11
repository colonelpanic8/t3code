import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type VoiceLiveError,
  type VoiceLiveToolExecuteResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * The curated catalog of tools a Live Voice call may run on this host via
 * `voice.live.tool.execute`. Deliberately small: reads are bounded, and every
 * mutation maps to one ordinary orchestration operation. Unknown tools and bad
 * arguments come back as `isError` results the voice model can read aloud, not
 * thrown errors.
 */

export class VoiceLiveToolExecutor extends Context.Service<
  VoiceLiveToolExecutor,
  {
    readonly execute: (
      toolName: string,
      args: unknown,
    ) => Effect.Effect<VoiceLiveToolExecuteResult, VoiceLiveError>;
  }
>()("t3/voice/VoiceLiveToolExecutor") {}

export const VOICE_LIVE_TOOL_NAMES = [
  "list_projects",
  "list_threads",
  "read_thread",
  "thread_status",
  "start_thread",
  "send_message",
  "interrupt_thread",
] as const;

/** Tools safe to fan out across every host at once. */
export const VOICE_LIVE_READ_TOOL_NAMES = [
  "list_projects",
  "list_threads",
  "read_thread",
  "thread_status",
] as const;

const DEFAULT_READ_THREAD_LIMIT = 30;
const MAX_READ_THREAD_LIMIT = 100;
const MAX_ITEM_CHARS = 2_000;
const MAX_LIST_THREADS = 50;

const ListThreadsArgs = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});

const ReadThreadArgs = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

const ThreadStatusArgs = Schema.Struct({
  threadId: ThreadId,
});

const StartThreadArgs = Schema.Struct({
  projectId: ProjectId,
  prompt: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});

const SendMessageArgs = Schema.Struct({
  threadId: ThreadId,
  message: Schema.String.check(Schema.isMinLength(1)),
});

const InterruptThreadArgs = Schema.Struct({
  threadId: ThreadId,
});

const okResult = (result: unknown): VoiceLiveToolExecuteResult => ({ result });

const errorResult = (message: string): VoiceLiveToolExecuteResult => ({
  result: { message },
  isError: true,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const truncate = (text: string): string =>
  text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}\n…[truncated]` : text;

const isoOrNull = (value: DateTime.DateTime | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const decodeArgs = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError((cause) => errorResult(`Invalid arguments: ${cause.message}`)),
    );

  const mintId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const threadShell = Effect.fn("VoiceLiveToolExecutor.threadShell")(function* (
    threadId: ThreadId,
  ) {
    const snapshot = yield* threadManagement
      .getShellSnapshot()
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    const shell = [...snapshot.threads, ...snapshot.archivedThreads].find(
      (candidate) => candidate.id === threadId,
    );
    if (shell === undefined) {
      return yield* Effect.fail(errorResult(`No thread ${threadId} on this host.`));
    }
    return shell;
  });

  const listProjects = Effect.fn("VoiceLiveToolExecutor.listProjects")(function* () {
    const snapshot = yield* snapshotQuery
      .getShellSnapshotWithoutEnrichment()
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    return okResult({
      projects: snapshot.projects.map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
    });
  });

  const listThreads = Effect.fn("VoiceLiveToolExecutor.listThreads")(function* (args: {
    readonly projectId?: ProjectId | undefined;
  }) {
    const snapshot = yield* threadManagement
      .getShellSnapshot()
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    const threads = snapshot.threads
      .filter((thread) => args.projectId === undefined || thread.projectId === args.projectId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      );
    return okResult({
      threads: threads.slice(0, MAX_LIST_THREADS).map((thread) => ({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        status: thread.status,
        activityRunStatus: thread.activityRunStatus ?? null,
        updatedAt: DateTime.formatIso(thread.updatedAt),
      })),
      total: threads.length,
    });
  });

  interface VoiceThreadTimelineItem {
    readonly type: "user_message" | "assistant_message" | "proposed_plan";
    readonly text: string;
    readonly updatedAt: string;
  }

  const readThread = Effect.fn("VoiceLiveToolExecutor.readThread")(function* (args: {
    readonly threadId: ThreadId;
    readonly limit?: number | undefined;
  }) {
    const projection = yield* threadManagement
      .getThreadProjection(args.threadId)
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    const limit = Math.min(args.limit ?? DEFAULT_READ_THREAD_LIMIT, MAX_READ_THREAD_LIMIT);
    const matching = projection.visibleTurnItems.flatMap(
      (row): ReadonlyArray<VoiceThreadTimelineItem> => {
        const item = row.item;
        switch (item.type) {
          case "user_message":
          case "assistant_message":
            return [
              {
                type: item.type,
                text: truncate(item.text),
                updatedAt: DateTime.formatIso(item.updatedAt),
              },
            ];
          case "proposed_plan":
            return [
              {
                type: item.type,
                text: truncate(item.markdown),
                updatedAt: DateTime.formatIso(item.updatedAt),
              },
            ];
          default:
            return [];
        }
      },
    );
    const page = matching.slice(-limit);
    return okResult({
      threadId: args.threadId,
      title: projection.thread.title,
      items: page,
      shownItems: page.length,
      totalItems: matching.length,
    });
  });

  const threadStatus = Effect.fn("VoiceLiveToolExecutor.threadStatus")(function* (args: {
    readonly threadId: ThreadId;
  }) {
    const shell = yield* threadShell(args.threadId);
    return okResult({
      threadId: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      status: shell.status,
      activityRunStatus: shell.activityRunStatus ?? null,
      lastError: shell.lastError ?? null,
      latestRunCompletedAt: isoOrNull(shell.latestRunCompletedAt),
      updatedAt: DateTime.formatIso(shell.updatedAt),
      archived: shell.archivedAt !== null,
    });
  });

  const startThread = Effect.fn("VoiceLiveToolExecutor.startThread")(function* (args: {
    readonly projectId: ProjectId;
    readonly prompt: string;
    readonly title?: string | undefined;
  }) {
    const project = yield* snapshotQuery
      .getProjectShellById(args.projectId)
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    if (Option.isNone(project)) {
      return yield* Effect.fail(errorResult(`No project ${args.projectId} on this host.`));
    }
    const modelSelection = project.value.defaultModelSelection;
    if (modelSelection === null) {
      return yield* Effect.fail(
        errorResult(
          `Project ${project.value.title} has no default model selection, so a voice call cannot pick one. Set a default model for the project in T3 Code first.`,
        ),
      );
    }
    const trimmedPrompt = args.prompt.trim();
    const title =
      args.title?.trim() ||
      (trimmedPrompt.length > 80 ? `${trimmedPrompt.slice(0, 77)}...` : trimmedPrompt);
    const uuid = yield* mintId;
    const result = yield* threadLaunch
      .launch({
        commandId: CommandId.make(`voice-live:${uuid}`),
        projectId: args.projectId,
        title,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`voice-live-message:${uuid}`),
          text: trimmedPrompt,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    return okResult({
      threadId: result.threadId,
      projectId: args.projectId,
      title,
    });
  });

  const sendMessage = Effect.fn("VoiceLiveToolExecutor.sendMessage")(function* (args: {
    readonly threadId: ThreadId;
    readonly message: string;
  }) {
    const shell = yield* threadShell(args.threadId);
    const uuid = yield* mintId;
    const messageId = MessageId.make(`voice-live-message:${uuid}`);
    const result = yield* threadManagement
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`voice-live:${uuid}`),
        threadId: args.threadId,
        messageId,
        text: args.message,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    return okResult({
      threadId: args.threadId,
      messageId,
      runId: result.run.id,
      status: result.run.status,
      delivery: result.delivery,
    });
  });

  const interruptThread = Effect.fn("VoiceLiveToolExecutor.interruptThread")(function* (args: {
    readonly threadId: ThreadId;
  }) {
    const shell = yield* threadShell(args.threadId);
    const uuid = yield* mintId;
    const result = yield* threadManagement
      .interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`voice-live:${uuid}`),
        threadId: args.threadId,
      })
      .pipe(Effect.mapError((error) => errorResult(errorMessage(error))));
    if (result.type === "no_active_run") {
      return okResult({ threadId: args.threadId, status: "no_active_run" });
    }
    return okResult({
      threadId: args.threadId,
      runId: result.run.id,
      status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
    });
  });

  const execute: VoiceLiveToolExecutor["Service"]["execute"] = Effect.fn(
    "VoiceLiveToolExecutor.execute",
  )((toolName, args) => {
    const run = (): Effect.Effect<VoiceLiveToolExecuteResult, VoiceLiveToolExecuteResult> => {
      switch (toolName) {
        case "list_projects":
          return listProjects();
        case "list_threads":
          return decodeArgs(ListThreadsArgs, args).pipe(Effect.flatMap(listThreads));
        case "read_thread":
          return decodeArgs(ReadThreadArgs, args).pipe(Effect.flatMap(readThread));
        case "thread_status":
          return decodeArgs(ThreadStatusArgs, args).pipe(Effect.flatMap(threadStatus));
        case "start_thread":
          return decodeArgs(StartThreadArgs, args).pipe(Effect.flatMap(startThread));
        case "send_message":
          return decodeArgs(SendMessageArgs, args).pipe(Effect.flatMap(sendMessage));
        case "interrupt_thread":
          return decodeArgs(InterruptThreadArgs, args).pipe(Effect.flatMap(interruptThread));
        default:
          return Effect.succeed(
            errorResult(
              `Unknown tool '${toolName}'. Valid tools: ${VOICE_LIVE_TOOL_NAMES.join(", ")}.`,
            ),
          );
      }
    };
    return run().pipe(
      // Domain failures and bad arguments read back as isError results so the
      // voice model can explain them; only defects escape.
      Effect.catch((failed) => Effect.succeed(failed)),
    );
  });

  return VoiceLiveToolExecutor.of({ execute });
});

export const layer = Layer.effect(VoiceLiveToolExecutor, make);
