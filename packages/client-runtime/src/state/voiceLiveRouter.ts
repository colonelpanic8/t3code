import type {
  EnvironmentId,
  VoiceLiveHost,
  VoiceLiveRouteRequest,
  VoiceLiveRouteResult,
  VoiceLiveToolExecuteInput,
  VoiceLiveToolExecuteResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Cross-host routing for Live Voice: the owning client answers `routeRequest`
 * events by reporting its connected environments (sanitized label + status
 * only) or by executing one routed tool against a target environment. The
 * error codes let the server's tools distinguish an unreachable host from a
 * tool that ran and failed.
 */

export type VoiceLiveRouteFailureCode =
  | "host_offline"
  | "unknown_host"
  | "tool_execution_unsupported"
  | "target_request_failed";

export type VoiceLiveRouteOutcome =
  | { readonly ok: true; readonly result: VoiceLiveRouteResult }
  | {
      readonly ok: false;
      readonly errorCode: VoiceLiveRouteFailureCode;
      readonly errorMessage: string;
    };

export interface VoiceLiveRouterDeps<R = never, E = never> {
  /** Snapshot of the client's connected environments as sanitized hosts. */
  readonly listHosts: Effect.Effect<ReadonlyArray<VoiceLiveHost>, never, R>;
  /** Runs `voice.live.tool.execute` against the target environment. */
  readonly executeTool: (
    targetEnvironmentId: EnvironmentId,
    input: VoiceLiveToolExecuteInput,
  ) => Effect.Effect<VoiceLiveToolExecuteResult, E, R>;
}

export type VoiceLiveTargetClassification =
  | { readonly ok: true; readonly host: VoiceLiveHost }
  | {
      readonly ok: false;
      readonly errorCode: Exclude<VoiceLiveRouteFailureCode, "target_request_failed">;
      readonly errorMessage: string;
    };

export function classifyVoiceLiveExecuteTarget(
  hosts: ReadonlyArray<VoiceLiveHost>,
  targetEnvironmentId: EnvironmentId,
): VoiceLiveTargetClassification {
  const host = hosts.find((candidate) => candidate.environmentId === targetEnvironmentId);
  if (host === undefined) {
    return {
      ok: false,
      errorCode: "unknown_host",
      errorMessage: "No connected environment matches the requested host.",
    };
  }
  if (!host.online) {
    return {
      ok: false,
      errorCode: "host_offline",
      errorMessage: `${host.label} is not connected right now.`,
    };
  }
  if (!host.toolExecutionSupported) {
    return {
      ok: false,
      errorCode: "tool_execution_unsupported",
      errorMessage: `${host.label} does not support Live Voice tool execution.`,
    };
  }
  return { ok: true, host };
}

export function describeVoiceLiveFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }
  return "The request failed.";
}

/** Answers one `routeRequest`. Never fails: failures become classified outcomes. */
export function routeVoiceLiveRequest<R, E>(
  routeRequest: VoiceLiveRouteRequest,
  deps: VoiceLiveRouterDeps<R, E>,
): Effect.Effect<VoiceLiveRouteOutcome, never, R> {
  switch (routeRequest.kind) {
    case "list_hosts":
      return Effect.map(
        deps.listHosts,
        (hosts): VoiceLiveRouteOutcome => ({
          ok: true,
          result: { kind: "list_hosts", hosts },
        }),
      );
    case "execute_tool":
      return Effect.flatMap(deps.listHosts, (hosts) => {
        const target = classifyVoiceLiveExecuteTarget(hosts, routeRequest.targetEnvironmentId);
        if (!target.ok) {
          return Effect.succeed<VoiceLiveRouteOutcome>(target);
        }
        return deps
          .executeTool(routeRequest.targetEnvironmentId, {
            toolName: routeRequest.toolName,
            arguments: routeRequest.arguments,
          })
          .pipe(
            Effect.timeoutOption(Duration.millis(routeRequest.timeoutMs)),
            Effect.map(
              Option.match({
                onNone: (): VoiceLiveRouteOutcome => ({
                  ok: false,
                  errorCode: "target_request_failed",
                  errorMessage: `${target.host.label} did not answer within ${routeRequest.timeoutMs}ms.`,
                }),
                onSome: (result): VoiceLiveRouteOutcome => ({
                  ok: true,
                  result: {
                    kind: "execute_tool",
                    targetEnvironmentId: routeRequest.targetEnvironmentId,
                    result: result.result,
                    ...(result.isError === undefined ? {} : { isError: result.isError }),
                  },
                }),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed<VoiceLiveRouteOutcome>({
                ok: false,
                errorCode: "target_request_failed",
                errorMessage: describeVoiceLiveFailure(cause),
              }),
            ),
          );
      });
  }
}
