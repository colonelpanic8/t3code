import {
  EnvironmentId,
  ProjectId,
  VoiceLiveError,
  type VoiceLiveHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  searchVoiceLiveProjects,
  type VoiceLiveProjectCandidate,
} from "../../../voice/VoiceLiveProjectSearch.ts";
import {
  DEFAULT_LIST_HOSTS_TIMEOUT_MS,
  VoiceLiveService,
} from "../../../voice/VoiceLiveService.ts";
import { VOICE_LIVE_READ_TOOL_NAMES } from "../../../voice/VoiceLiveToolExecutor.ts";
import { VoiceMcpInvocationContext } from "../../VoiceMcpInvocationContext.ts";
import { VoiceToolkit } from "./tools.ts";

const isReadyHost = (host: VoiceLiveHost): boolean => host.online && host.toolExecutionSupported;

const describeUnreadyHost = (host: VoiceLiveHost): string =>
  host.online ? "needs a T3 Code upgrade" : "offline";

const isFanOutTool = (toolName: string): boolean =>
  (VOICE_LIVE_READ_TOOL_NAMES as ReadonlyArray<string>).includes(toolName);

/** A tool that reports failure via `isError` puts the explanation in its result. */
const describeIsErrorResult = (result: unknown): string =>
  typeof result === "object" &&
  result !== null &&
  "message" in result &&
  typeof result.message === "string"
    ? result.message
    : "the tool reported an error";

const listHosts = Effect.fn("VoiceToolkit.listHosts")(function* () {
  const invocation = yield* VoiceMcpInvocationContext;
  const service = yield* VoiceLiveService;
  const result = yield* service.routeExecute(invocation.liveSessionId, { kind: "list_hosts" });
  if (result.kind !== "list_hosts") {
    return yield* new VoiceLiveError({
      message: `The routing client answered list_hosts with '${result.kind}'.`,
      code: "malformed_route_response",
      liveSessionId: invocation.liveSessionId,
    });
  }
  return result.hosts;
});

interface HostReport {
  environmentId: VoiceLiveHost["environmentId"];
  label: string;
  reason: string;
}

interface FanOutOutcome {
  readonly successes: Array<{ host: VoiceLiveHost; result: unknown }>;
  readonly unavailableHosts: HostReport[];
  readonly erroredHosts: HostReport[];
}

const toHostReport = (host: VoiceLiveHost, reason: string): HostReport => ({
  environmentId: host.environmentId,
  label: host.label,
  reason,
});

/**
 * One read, every ready host, one model turn: nothing here is sequential. A
 * host that failed is reported by name, never folded into an empty result —
 * what the user asked about may well be on it.
 */
const fanOutRead = Effect.fn("VoiceToolkit.fanOutRead")(function* (input: {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const invocation = yield* VoiceMcpInvocationContext;
  const service = yield* VoiceLiveService;
  const hosts = yield* listHosts();
  const requested = input.environmentId
    ? hosts.filter((host) => host.environmentId === input.environmentId)
    : hosts;
  if (input.environmentId !== undefined && requested.length === 0) {
    return yield* new VoiceLiveError({
      message: `Unknown environment '${input.environmentId}'. Call list_hosts for the current list.`,
      code: "unknown_host",
      liveSessionId: invocation.liveSessionId,
    });
  }
  const unavailableHosts = requested
    .filter((host) => !isReadyHost(host))
    .map((host) => toHostReport(host, describeUnreadyHost(host)));
  const erroredHosts: HostReport[] = [];
  const successes: Array<{ host: VoiceLiveHost; result: unknown }> = [];
  yield* Effect.forEach(
    requested.filter(isReadyHost),
    (host) =>
      service
        .routeExecute(
          invocation.liveSessionId,
          {
            kind: "execute_tool",
            targetEnvironmentId: host.environmentId,
            toolName: input.toolName,
            arguments: input.arguments,
          },
          { timeoutMs: DEFAULT_LIST_HOSTS_TIMEOUT_MS },
        )
        .pipe(
          Effect.map((result) => {
            if (result.kind === "execute_tool" && result.isError !== true) {
              successes.push({ host, result: result.result });
            } else {
              erroredHosts.push(
                toHostReport(
                  host,
                  result.kind === "execute_tool"
                    ? describeIsErrorResult(result.result)
                    : "answered with the wrong result kind",
                ),
              );
            }
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              unavailableHosts.push(toHostReport(host, error.message));
            }),
          ),
        ),
    { concurrency: "unbounded", discard: true },
  );
  return { successes, unavailableHosts, erroredHosts } satisfies FanOutOutcome;
});

const ProjectListing = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
  ),
});

const decodeProjectListing = Schema.decodeUnknownEffect(ProjectListing);

const handlers = {
  list_hosts: () => listHosts().pipe(Effect.map((hosts) => ({ hosts }))),
  run_t3_tool_on_host: (input) =>
    Effect.gen(function* () {
      const invocation = yield* VoiceMcpInvocationContext;
      const service = yield* VoiceLiveService;
      const result = yield* service.routeExecute(invocation.liveSessionId, {
        kind: "execute_tool",
        targetEnvironmentId: input.environmentId,
        toolName: input.toolName,
        arguments: input.arguments,
      });
      if (result.kind !== "execute_tool") {
        return yield* new VoiceLiveError({
          message: `The routing client answered ${input.toolName} with '${result.kind}'.`,
          code: "malformed_route_response",
          liveSessionId: invocation.liveSessionId,
        });
      }
      return {
        environmentId: result.targetEnvironmentId,
        result: result.result,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    }),
  run_t3_tool_on_all_hosts: (input) =>
    Effect.gen(function* () {
      const invocation = yield* VoiceMcpInvocationContext;
      if (!isFanOutTool(input.toolName)) {
        return yield* new VoiceLiveError({
          message: `'${input.toolName}' cannot run on every host at once. Run it on one host with run_t3_tool_on_host, or fan out one of: ${VOICE_LIVE_READ_TOOL_NAMES.join(", ")}.`,
          code: "fan_out_not_allowed",
          liveSessionId: invocation.liveSessionId,
        });
      }
      const outcome = yield* fanOutRead({
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      });
      return {
        toolName: input.toolName,
        results: outcome.successes.map(({ host, result }) => ({
          environmentId: host.environmentId,
          label: host.label,
          result,
        })),
        unavailableHosts: outcome.unavailableHosts,
        erroredHosts: outcome.erroredHosts,
      };
    }),
  find_project: (input) =>
    Effect.gen(function* () {
      const outcome = yield* fanOutRead({
        toolName: "list_projects",
        arguments: {},
        environmentId: input.environmentId,
      });
      // A host whose listing does not parse was not searched, whatever it sent
      // back. Counting it as "searched, empty" would let a version-skewed host
      // silently hide the project the user just named.
      const searchedHosts: Array<{
        environmentId: VoiceLiveHost["environmentId"];
        label: string;
      }> = [];
      const erroredHosts = [...outcome.erroredHosts];
      const candidates: VoiceLiveProjectCandidate[] = [];
      for (const { host, result } of outcome.successes) {
        const listing = yield* decodeProjectListing(result).pipe(Effect.option);
        if (listing._tag === "None") {
          erroredHosts.push(
            toHostReport(host, "returned a project list this call could not read"),
          );
          continue;
        }
        searchedHosts.push({ environmentId: host.environmentId, label: host.label });
        candidates.push(
          ...listing.value.projects.map((project) => ({
            environmentId: host.environmentId,
            hostLabel: host.label,
            projectId: project.projectId,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        );
      }
      const search = searchVoiceLiveProjects(input.query, candidates);
      return {
        resolution: search.resolution,
        matches: search.matches,
        searchedHosts,
        unavailableHosts: outcome.unavailableHosts,
        erroredHosts,
      };
    }),
} satisfies Parameters<typeof VoiceToolkit.toLayer>[0];

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer(handlers);
