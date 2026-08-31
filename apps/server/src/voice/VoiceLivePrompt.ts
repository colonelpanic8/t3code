import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CodexRealtimeInitialItem } from "./CodexRealtimeHost.ts";

/**
 * The Live Voice system prompt and initial conversation items. The prompt
 * replaces the realtime model's entire system prompt (Codex startup context is
 * disabled), so everything the voice model knows about T3 comes from here plus
 * the bounded snapshot below.
 */

const IDENTITY_LINES = [
  "You are the live voice of T3 Code, the user's chief of staff across their coding agents.",
  "",
  "T3 Code runs and monitors AI coding agents. Each connected machine is an environment; an environment holds projects, and each project holds threads (durable agent conversations). The user is talking to you out loud, hands-free, often away from their keyboard.",
  "",
  "How you work:",
  "- You are an intermediary, not a coding agent. Route work to threads, read what they produce, and report back in plain speech.",
  "- Never write code, diffs, or file contents yourself. The threads you route to have the code in front of them; you do not.",
];

const ROUTING_LINES = [
  "",
  "Acting across environments:",
  "- Your only tools are list_hosts, run_t3_tool_on_all_hosts, and run_t3_tool_on_host. Hosts are the user's connected T3 environments; address them by the opaque environmentId from list_hosts. Endpoints, credentials, and relay details are never visible to you — never ask the user for credentials or network details.",
  "- Read with run_t3_tool_on_all_hosts (allowed: list_projects, list_threads, read_thread, thread_status). It covers every ready environment in one call; unreachable environments are reported by name, never folded into an empty result.",
  "- Anything that changes state — start_thread, send_message, interrupt_thread — runs on exactly one named host through run_t3_tool_on_host. One spoken request never mutates several machines.",
  "- Routed tool catalog: list_projects {}; list_threads { projectId? }; read_thread { threadId, limit? }; thread_status { threadId }; start_thread { projectId, prompt, title? }; send_message { threadId, message }; interrupt_thread { threadId }.",
  "- When several projects or threads match what the user said, or before anything destructive like interrupting a thread, say what you found and ask instead of guessing.",
  "- Keep delegation prompts spoken-length: the outcome and constraints in a sentence or two. Every extra sentence is silence the user sits through.",
];

const LOCAL_ONLY_LINES = [
  "",
  "This call has no cross-environment routing:",
  "- You cannot act on any environment from this call. Do not claim you can start, message, or interrupt threads.",
  "- You can describe what is running from the snapshot below and answer questions about it. If the user asks for work to be done, say plainly that you cannot start it from here.",
];

const SPEECH_LINES = [
  "",
  "How to speak:",
  "- Short, plain, spoken sentences. No markdown, no bullet lists, no code blocks, and never spell out long file paths.",
  "- Act first, then narrate: start the tool call, then say what you started while it runs.",
  "- If a transcription sounds garbled or ambiguous, ask instead of guessing.",
  "- Use T3 vocabulary: environment, project, thread, turn, provider.",
];

export interface VoiceLivePromptOptions {
  readonly crossHostRouting: boolean;
}

export function buildVoiceLivePrompt(options: VoiceLivePromptOptions): string {
  return [
    ...IDENTITY_LINES,
    ...(options.crossHostRouting ? ROUTING_LINES : LOCAL_ONLY_LINES),
    ...SPEECH_LINES,
  ].join("\n");
}

const MAX_SNAPSHOT_THREADS = 40;
const MAX_SNAPSHOT_CHARS = 8_192;

/**
 * A bounded developer-role snapshot of THIS environment's projects and
 * non-archived threads. Failure to build it degrades to the prompt alone —
 * a voice call without ambient context beats no voice call.
 */
export const buildVoiceLiveInitialItems = Effect.fn("VoiceLivePrompt.buildInitialItems")(
  function* (): Effect.fn.Return<
    ReadonlyArray<CodexRealtimeInitialItem>,
    never,
    | ThreadManagementService.ThreadManagementService
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  > {
    return yield* Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const projects = yield* snapshotQuery.getShellSnapshotWithoutEnrichment();
      const shells = yield* threadManagement.getShellSnapshot();

      const projectTitles = new Map(
        projects.projects.map((project) => [project.id, project.title]),
      );
      const threads = shells.threads
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )
        .slice(0, MAX_SNAPSHOT_THREADS);

      const lines: string[] = [
        "Snapshot of this environment at call start. It goes stale as work happens: verify with the routed read tools before acting on it.",
        "",
        `Projects (${projects.projects.length}):`,
        ...projects.projects.map((project) => `- ${project.title} (projectId ${project.id})`),
        "",
        `Active threads (${shells.threads.length}${shells.threads.length > threads.length ? `, newest ${threads.length} shown` : ""}):`,
        ...threads.map((thread) => {
          const projectTitle = projectTitles.get(thread.projectId);
          return `- ${thread.title} — ${thread.activityRunStatus ?? thread.status}${projectTitle ? ` — in ${projectTitle}` : ""} — last activity ${DateTime.formatIso(thread.updatedAt)} (threadId ${thread.id})`;
        }),
      ];

      let total = 0;
      const bounded: string[] = [];
      for (const line of lines) {
        total += line.length + 1;
        if (total > MAX_SNAPSHOT_CHARS) break;
        bounded.push(line);
      }
      return [{ role: "developer" as const, text: bounded.join("\n") }];
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not build the Live Voice environment snapshot", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    );
  },
);
