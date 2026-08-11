import {
  EnvironmentId,
  ProjectId,
  TrimmedNonEmptyString,
  VoiceLiveError,
  VoiceLiveHost,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { VoiceLiveService } from "../../../voice/VoiceLiveService.ts";
import { VoiceMcpInvocationContext } from "../../VoiceMcpInvocationContext.ts";

/**
 * The complete tool surface of a Live Voice call. Served on the dedicated
 * `/mcp/voice` transport so the voice model can never see the orchestrator,
 * preview, or worktree toolkits, and the routed tools cannot recursively
 * acquire Live Voice.
 */

const dependencies = [VoiceMcpInvocationContext, VoiceLiveService];

const ROUTED_TOOL_CATALOG =
  "Routed tool catalog (name { arguments } — purpose): " +
  "list_projects {} — the projects on that environment; " +
  "list_threads { projectId? } — thread titles with status and last activity; " +
  "read_thread { threadId, limit? } — the recent conversation tail of one thread; " +
  "thread_status { threadId } — run status for one thread; " +
  "start_thread { projectId, prompt, title? } — start a fresh agent thread; " +
  "send_message { threadId, message } — send a follow-up to an existing thread; " +
  "interrupt_thread { threadId } — stop a thread's active turn.";

const HostReport = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  reason: Schema.String,
});

export const ListHostsTool = Tool.make("list_hosts", {
  description:
    "List the user's connected T3 environments (hosts) visible to this voice call. Act only on hosts that are online with toolExecutionSupported=true; describe the rest as offline or needing a T3 Code upgrade. Use the opaque environmentId with run_t3_tool_on_host and run_t3_tool_on_all_hosts. When the user names a project, call find_project instead — it searches every ready host in one call. Host endpoints and credentials are never exposed — never ask the user for them.",
  success: Schema.Struct({ hosts: Schema.Array(VoiceLiveHost) }),
  failure: VoiceLiveError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List connected environments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const RunToolOnHostTool = Tool.make("run_t3_tool_on_host", {
  description: `Run one routed T3 tool on a single ready environment, named by environmentId from list_hosts. ${ROUTED_TOOL_CATALOG} Anything that changes state — start_thread, send_message, interrupt_thread — must run here against exactly one named environment, never fanned out, so one spoken request never mutates several machines. Pass only the target tool's arguments. Confirm with the user before interrupt_thread or when several threads match what they said. Never ask for or pass host credentials or network endpoints.`,
  parameters: Schema.Struct({
    environmentId: EnvironmentId,
    toolName: TrimmedNonEmptyString,
    arguments: Schema.Unknown,
  }),
  success: Schema.Struct({
    environmentId: EnvironmentId,
    result: Schema.Unknown,
    isError: Schema.optional(Schema.Boolean),
  }),
  failure: VoiceLiveError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a T3 tool on one environment")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const RunToolOnAllHostsTool = Tool.make("run_t3_tool_on_all_hosts", {
  description: `Run one read-only routed T3 tool on every ready environment at once and get one result per host. Use this for any question about the user's machines as a whole — what is running anywhere — instead of calling list_hosts and then run_t3_tool_on_host per machine. When the user names a project, prefer find_project. Only these tools fan out: list_projects, list_threads, read_thread, thread_status. ${ROUTED_TOOL_CATALOG} unavailableHosts could not be reached at all; erroredHosts answered but this read failed there — never present either as a machine holding nothing.`,
  parameters: Schema.Struct({
    toolName: TrimmedNonEmptyString,
    arguments: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Struct({
    toolName: TrimmedNonEmptyString,
    results: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        label: TrimmedNonEmptyString,
        result: Schema.Unknown,
      }),
    ),
    unavailableHosts: Schema.Array(HostReport),
    erroredHosts: Schema.Array(HostReport),
  }),
  failure: VoiceLiveError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a T3 read on every environment")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const FindProjectTool = Tool.make("find_project", {
  description:
    "Resolve a project the user named out loud into the exact environmentId and projectId needed to act on it, searching every ready environment at once. Use this instead of list_hosts followed by list_projects whenever the user names a project. Matching ignores case, punctuation, and hyphens, and covers both the project title and its directory name. Read the resolution before acting: unique_exact identifies one project and is safe to act on; ambiguous_exact means several projects share the name, so ask which environment or directory the user meant; unique_partial and ambiguous_partial mean nothing matched exactly, so confirm before acting; none means no project matched. Never guess between matches for interrupt_thread or any other destructive action. Pass the returned environmentId and projectId straight to run_t3_tool_on_host.",
  parameters: Schema.Struct({
    query: TrimmedNonEmptyString.annotate({
      description: "The project name as the user said it.",
    }),
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description: "Search only this environment. Omit to search every ready environment.",
      }),
    ),
  }),
  success: Schema.Struct({
    resolution: Schema.Literals([
      "unique_exact",
      "ambiguous_exact",
      "unique_partial",
      "ambiguous_partial",
      "none",
    ]),
    matches: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        hostLabel: TrimmedNonEmptyString,
        projectId: ProjectId,
        title: Schema.String,
        workspaceRoot: Schema.String,
        matchKind: Schema.Literals(["exact", "partial"]),
      }),
    ),
    searchedHosts: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
    ),
    unavailableHosts: Schema.Array(HostReport),
    erroredHosts: Schema.Array(HostReport),
  }),
  failure: VoiceLiveError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Find a project by name")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const VoiceToolkit = Toolkit.make(
  ListHostsTool,
  RunToolOnHostTool,
  RunToolOnAllHostsTool,
  FindProjectTool,
);
