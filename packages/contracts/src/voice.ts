import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Live Voice: an ephemeral realtime speech-to-speech call between a client and
 * OpenAI, brokered by one T3 server through a hidden Codex app-server session
 * (`--enable realtime_conversation`). Media flows client <-> OpenAI over
 * WebRTC; only SDP, control messages, finalized transcripts, and routed tool
 * calls cross the T3 wire. Nothing in this domain enters the durable
 * orchestration timeline.
 */

export const VoiceLiveSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type VoiceLiveSessionId = typeof VoiceLiveSessionId.Type;

export const VoiceLiveRouteRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type VoiceLiveRouteRequestId = typeof VoiceLiveRouteRequestId.Type;

/** JSON-safe arguments/results for routed tools. Wire-validated as unknown. */
export const VoiceLiveJson = Schema.Unknown;

/**
 * SDP is whitespace-significant: the final line's CRLF terminator must survive
 * the wire in both directions. OpenAI's realtime endpoint and Chrome's
 * setRemoteDescription both reject an SDP whose last line is unterminated, so
 * this deliberately does not trim.
 */
export const VoiceLiveSdp = Schema.String.check(Schema.isNonEmpty());

export const VoiceLiveTranscriptRole = Schema.Literals(["user", "assistant"]);
export type VoiceLiveTranscriptRole = typeof VoiceLiveTranscriptRole.Type;

export const VoiceLiveStartInput = Schema.Struct({
  /** WebRTC offer SDP from the client's RTCPeerConnection (audio + events data channel). */
  offerSdp: VoiceLiveSdp,
  /** Realtime voice preset name; the provider default applies when omitted. */
  voice: Schema.optional(TrimmedNonEmptyString),
  /** Codex provider instance that hosts the call. Defaults to the first ready Codex instance. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /**
   * Whether the owning client can execute routed tool calls against its other
   * connected environments. When false the call is local-only and the voice
   * model is told it cannot act across hosts.
   */
  crossHostRouting: Schema.optional(Schema.Boolean),
});
export type VoiceLiveStartInput = typeof VoiceLiveStartInput.Type;

export const VoiceLiveStopInput = Schema.Struct({
  liveSessionId: VoiceLiveSessionId,
});
export type VoiceLiveStopInput = typeof VoiceLiveStopInput.Type;

export const VoiceLiveStopResult = Schema.Struct({
  stopped: Schema.Boolean,
});
export type VoiceLiveStopResult = typeof VoiceLiveStopResult.Type;

/**
 * A host as presented to the voice model: sanitized label and status only.
 * Endpoints, credentials, and relay details never cross this boundary.
 */
export const VoiceLiveHost = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  online: Schema.Boolean,
  /** Target server advertises the `voiceLiveToolExecution` capability. */
  toolExecutionSupported: Schema.Boolean,
});
export type VoiceLiveHost = typeof VoiceLiveHost.Type;

export const VoiceLiveRouteRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("list_hosts"),
    requestId: VoiceLiveRouteRequestId,
  }),
  Schema.Struct({
    kind: Schema.Literal("execute_tool"),
    requestId: VoiceLiveRouteRequestId,
    targetEnvironmentId: EnvironmentId,
    toolName: TrimmedNonEmptyString,
    arguments: VoiceLiveJson,
    timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type VoiceLiveRouteRequest = typeof VoiceLiveRouteRequest.Type;

export const VoiceLiveRouteResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("list_hosts"),
    hosts: Schema.Array(VoiceLiveHost),
  }),
  Schema.Struct({
    kind: Schema.Literal("execute_tool"),
    targetEnvironmentId: EnvironmentId,
    result: VoiceLiveJson,
    isError: Schema.optional(Schema.Boolean),
  }),
]);
export type VoiceLiveRouteResult = typeof VoiceLiveRouteResult.Type;

export const VoiceLiveRouteResponse = Schema.Struct({
  liveSessionId: VoiceLiveSessionId,
  requestId: VoiceLiveRouteRequestId,
  ok: Schema.Boolean,
  result: Schema.optional(VoiceLiveRouteResult),
  /** Open string so newer peers can introduce codes without breaking older servers. */
  errorCode: Schema.optional(TrimmedNonEmptyString),
  errorMessage: Schema.optional(Schema.String),
});
export type VoiceLiveRouteResponse = typeof VoiceLiveRouteResponse.Type;

export const VoiceLiveRouteRespondResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type VoiceLiveRouteRespondResult = typeof VoiceLiveRouteRespondResult.Type;

/**
 * Events on the `voice.live.start` stream. `seq` is monotonically increasing
 * per call so clients can drop stale or replayed updates. The first event is
 * always `started`; `answer` follows once Codex produces the answer SDP; a
 * terminal `closed` (or stream end) means the call is over and torn down.
 */
export const VoiceLiveStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    /** Codex realtime model/session version when reported. */
    realtimeVersion: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("answer"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    sdp: VoiceLiveSdp,
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    role: VoiceLiveTranscriptRole,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("routeRequest"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    request: VoiceLiveRouteRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    seq: Schema.Int,
    liveSessionId: VoiceLiveSessionId,
    reason: Schema.NullOr(Schema.String),
  }),
]);
export type VoiceLiveStreamEvent = typeof VoiceLiveStreamEvent.Type;

/**
 * Executed on the target host by the routing client. `toolName` stays an open
 * string: the catalog is server-defined and may grow without a contract change.
 */
export const VoiceLiveToolExecuteInput = Schema.Struct({
  toolName: TrimmedNonEmptyString,
  arguments: VoiceLiveJson,
});
export type VoiceLiveToolExecuteInput = typeof VoiceLiveToolExecuteInput.Type;

export const VoiceLiveToolExecuteResult = Schema.Struct({
  result: VoiceLiveJson,
  isError: Schema.optional(Schema.Boolean),
});
export type VoiceLiveToolExecuteResult = typeof VoiceLiveToolExecuteResult.Type;

export class VoiceLiveError extends Schema.TaggedErrorClass<VoiceLiveError>()("VoiceLiveError", {
  message: Schema.String,
  /** Open string for version skew: unavailable, busy, provider_too_old, unauthenticated, ... */
  code: Schema.optional(TrimmedNonEmptyString),
  liveSessionId: Schema.optional(VoiceLiveSessionId),
  cause: Schema.optional(Schema.Defect()),
}) {}
