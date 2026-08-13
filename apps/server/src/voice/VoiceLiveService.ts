import {
  CodexSettings,
  ProviderDriverKind,
  VoiceLiveError,
  defaultInstanceIdForDriver,
  type AuthSessionId,
  type EnvironmentId,
  type ProviderInstanceId,
  type RpcClientId,
  type VoiceLiveRouteRespondResult,
  type VoiceLiveRouteResponse,
  type VoiceLiveRouteResult,
  type VoiceLiveSessionId,
  type VoiceLiveStartInput,
  type VoiceLiveStopResult,
  type VoiceLiveStreamEvent,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  openCodexRealtimeHost,
  type CodexRealtimeEvent,
  type CodexRealtimeHost,
  type OpenCodexRealtimeHostInput,
} from "./CodexRealtimeHost.ts";
import * as VoiceLivePrompt from "./VoiceLivePrompt.ts";

/**
 * In-memory broker for Live Voice calls. A call is owned by the exact client
 * socket that started it, lives exactly as long as its `voice.live.start`
 * stream, and never touches the durable orchestration timeline. Every exit —
 * client stop, socket loss, Codex death, startup failure — converges on the
 * same idempotent teardown.
 */

export interface VoiceLiveOwner {
  readonly sessionId: AuthSessionId;
  readonly rpcClientId: RpcClientId;
}

/** A route request as the MCP toolkit issues it: the broker mints the requestId. */
export type VoiceLiveRouteExecuteRequest =
  | { readonly kind: "list_hosts" }
  | {
      readonly kind: "execute_tool";
      readonly targetEnvironmentId: EnvironmentId;
      readonly toolName: string;
      readonly arguments: unknown;
    };

export interface VoiceLiveRouteExecuteOptions {
  readonly timeoutMs?: number;
}

export class VoiceLiveService extends Context.Service<
  VoiceLiveService,
  {
    readonly start: (
      input: VoiceLiveStartInput,
      owner: VoiceLiveOwner,
    ) => Effect.Effect<Stream.Stream<VoiceLiveStreamEvent, VoiceLiveError>, VoiceLiveError>;
    readonly stop: (
      liveSessionId: VoiceLiveSessionId,
      owner: VoiceLiveOwner,
    ) => Effect.Effect<VoiceLiveStopResult, VoiceLiveError>;
    readonly respond: (
      response: VoiceLiveRouteResponse,
      owner: VoiceLiveOwner,
    ) => Effect.Effect<VoiceLiveRouteRespondResult, VoiceLiveError>;
    readonly routeExecute: (
      liveSessionId: VoiceLiveSessionId,
      request: VoiceLiveRouteExecuteRequest,
      options?: VoiceLiveRouteExecuteOptions,
    ) => Effect.Effect<VoiceLiveRouteResult, VoiceLiveError>;
    readonly resolveVoiceCredential: (
      rawToken: string,
    ) => Effect.Effect<{ readonly liveSessionId: VoiceLiveSessionId } | undefined>;
  }
>()("t3/voice/VoiceLiveService") {}

/** Discovery answers fast or not at all; agent-backed tool turns can be slow. */
export const DEFAULT_LIST_HOSTS_TIMEOUT_MS = 30_000;
export const DEFAULT_EXECUTE_TOOL_TIMEOUT_MS = 600_000;

const SDP_ANSWER_TIMEOUT_MS = 60_000;

export type OpenVoiceRealtimeHost = (
  input: OpenCodexRealtimeHostInput,
) => Effect.Effect<CodexRealtimeHost, VoiceLiveError, Scope.Scope>;

export interface VoiceLiveServiceOptions {
  readonly openHost: OpenVoiceRealtimeHost;
}

type VoiceLiveStreamEventBody = VoiceLiveStreamEvent extends infer Event
  ? Event extends { readonly seq: number }
    ? Omit<Event, "seq">
    : never
  : never;

interface VoiceCallRecord {
  readonly liveSessionId: VoiceLiveSessionId;
  readonly owner: VoiceLiveOwner;
  readonly ownerKey: string;
  readonly tokenHash: string;
  readonly queue: Queue.Queue<VoiceLiveStreamEvent, VoiceLiveError | Cause.Done>;
  readonly seq: Ref.Ref<number>;
  readonly scope: Scope.Closeable;
  readonly host: CodexRealtimeHost;
  readonly codexEvents: Queue.Queue<CodexRealtimeEvent, Cause.Done>;
  readonly sdpReceived: Deferred.Deferred<void>;
  readonly pending: ReadonlyMap<string, Deferred.Deferred<VoiceLiveRouteResult, VoiceLiveError>>;
}

interface VoiceLiveState {
  readonly calls: ReadonlyMap<VoiceLiveSessionId, VoiceCallRecord>;
  /** `${sessionId}\0${rpcClientId}` -> live session; at most one call per socket. */
  readonly owners: ReadonlyMap<string, VoiceLiveSessionId>;
  /** SHA-256 token hash -> live session; the raw voice MCP token is never stored. */
  readonly tokens: ReadonlyMap<string, VoiceLiveSessionId>;
}

const ownerKeyOf = (owner: VoiceLiveOwner): string =>
  `${owner.sessionId}\u0000${owner.rpcClientId}`;

const sameOwner = (left: VoiceLiveOwner, right: VoiceLiveOwner): boolean =>
  left.sessionId === right.sessionId && left.rpcClientId === right.rpcClientId;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const getVoiceMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const makeWithOptions = Effect.fn("VoiceLiveService.make")(function* (
  options: VoiceLiveServiceOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<VoiceLiveState>({
    calls: new Map(),
    owners: new Map(),
    tokens: new Map(),
  });
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getVoiceMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp/voice`
      : "http://127.0.0.1/mcp/voice";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const emit = (record: VoiceCallRecord, event: VoiceLiveStreamEventBody) =>
    Ref.updateAndGet(record.seq, (seq) => seq + 1).pipe(
      Effect.flatMap((seq) => Queue.offer(record.queue, { ...event, seq } as VoiceLiveStreamEvent)),
      Effect.asVoid,
    );

  const teardown = Effect.fn("VoiceLiveService.teardown")(function* (
    liveSessionId: VoiceLiveSessionId,
    reason: string | null,
  ) {
    const removed = yield* SynchronizedRef.modify(state, (current) => {
      const record = current.calls.get(liveSessionId);
      if (!record) return [undefined, current] as const;
      const calls = new Map(current.calls);
      calls.delete(liveSessionId);
      const owners = new Map(current.owners);
      if (owners.get(record.ownerKey) === liveSessionId) owners.delete(record.ownerKey);
      const tokens = new Map(current.tokens);
      tokens.delete(record.tokenHash);
      return [record, { calls, owners, tokens }] as const;
    });
    if (!removed) return false;
    yield* Deferred.succeed(removed.sdpReceived, undefined);
    yield* removed.host.stop.pipe(Effect.timeoutOption(2_000), Effect.ignore);
    yield* Scope.close(removed.scope, Exit.void);
    yield* Effect.forEach(
      removed.pending.values(),
      (pending) =>
        Deferred.fail(
          pending,
          new VoiceLiveError({
            message: "The voice call closed before this routed request completed.",
            code: "call_closed",
            liveSessionId,
          }),
        ),
      { discard: true },
    );
    yield* emit(removed, { type: "closed", liveSessionId, reason });
    yield* Queue.end(removed.queue);
    yield* Queue.end(removed.codexEvents);
    return true;
  });

  const resolveCodexSettings = Effect.fn("VoiceLiveService.resolveCodexSettings")(function* (
    providerInstanceId: ProviderInstanceId | undefined,
  ): Effect.fn.Return<CodexSettings, VoiceLiveError> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new VoiceLiveError({
            message: "Could not read server settings for the voice call.",
            code: "unavailable",
            cause,
          }),
      ),
    );
    const codexEnvelope = (instanceId: ProviderInstanceId) => {
      const envelope = settings.providerInstances[instanceId];
      return envelope?.driver === CODEX_DRIVER_KIND ? envelope : undefined;
    };
    const envelope =
      (providerInstanceId !== undefined ? codexEnvelope(providerInstanceId) : undefined) ??
      codexEnvelope(defaultInstanceIdForDriver(CODEX_DRIVER_KIND));
    if (envelope === undefined) return settings.providers.codex;
    return yield* decodeCodexSettings(envelope.config ?? {}).pipe(
      Effect.mapError(
        (cause) =>
          new VoiceLiveError({
            message: "The configured Codex instance settings could not be decoded.",
            code: "unavailable",
            cause,
          }),
      ),
    );
  });

  const start: VoiceLiveService["Service"]["start"] = Effect.fn("VoiceLiveService.start")(
    function* (input, owner) {
      const ownerKey = ownerKeyOf(owner);
      const liveSessionId: VoiceLiveSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const reserved = yield* SynchronizedRef.modify(state, (current) => {
        if (current.owners.has(ownerKey)) return [false, current] as const;
        const owners = new Map(current.owners);
        owners.set(ownerKey, liveSessionId);
        return [true, { ...current, owners }] as const;
      });
      if (!reserved) {
        return yield* new VoiceLiveError({
          message:
            "A Live Voice call is already active on this connection. Stop it before starting another.",
          code: "busy",
        });
      }
      const scope = yield* Scope.make();
      const record = yield* Effect.gen(function* () {
        const codexSettings = yield* resolveCodexSettings(input.providerInstanceId);
        const crossHostRouting = input.crossHostRouting !== false;
        const rawToken = yield* crypto.randomBytes(32).pipe(
          Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
          Effect.orDie,
        );
        const tokenHash = yield* hashToken(rawToken);
        const codexEvents = yield* Queue.unbounded<CodexRealtimeEvent, Cause.Done>();
        const host = yield* options
          .openHost({
            binaryPath: codexSettings.binaryPath || "codex",
            homePath: codexSettings.homePath || undefined,
            cwd: config.stateDir,
            ...(crossHostRouting
              ? { mcp: { endpoint, authorizationHeader: `Bearer ${rawToken}` } }
              : {}),
            onEvent: (event) => {
              Queue.offerUnsafe(codexEvents, event);
            },
          })
          .pipe(Scope.provide(scope));

        const queue = yield* Queue.unbounded<VoiceLiveStreamEvent, VoiceLiveError | Cause.Done>();
        const call: VoiceCallRecord = {
          liveSessionId,
          owner,
          ownerKey,
          tokenHash,
          queue,
          seq: yield* Ref.make(0),
          scope,
          host,
          codexEvents,
          sdpReceived: yield* Deferred.make<void>(),
          pending: new Map(),
        };
        yield* SynchronizedRef.update(state, (current) => {
          const calls = new Map(current.calls);
          calls.set(liveSessionId, call);
          const tokens = new Map(current.tokens);
          tokens.set(tokenHash, liveSessionId);
          return { ...current, calls, tokens };
        });
        yield* emit(call, {
          type: "started",
          liveSessionId,
          realtimeVersion: host.codexVersion,
        });

        const prompt = VoiceLivePrompt.buildVoiceLivePrompt({ crossHostRouting });
        const initialItems = yield* VoiceLivePrompt.buildVoiceLiveInitialItems().pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
        );
        yield* host.start({
          offerSdp: input.offerSdp,
          ...(input.voice === undefined ? {} : { voice: input.voice }),
          prompt,
          ...(initialItems.length > 0 ? { initialItems } : {}),
        });

        const handleCodexEvent = (event: CodexRealtimeEvent) => {
          switch (event.kind) {
            case "started":
              // The stream's `started` already went out with the session id.
              return Effect.void;
            case "sdp":
              return Deferred.succeed(call.sdpReceived, undefined).pipe(
                Effect.andThen(emit(call, { type: "answer", liveSessionId, sdp: event.sdp })),
              );
            case "transcript":
              return emit(call, {
                type: "transcript",
                liveSessionId,
                role: event.role,
                text: event.text,
              });
            case "error":
              return emit(call, { type: "error", liveSessionId, message: event.message });
            case "closed":
              return teardown(liveSessionId, event.reason ?? "codex_closed").pipe(Effect.asVoid);
          }
        };
        // Detached rather than call-scoped: the pump itself runs teardown on
        // Codex `closed`, and teardown closes the call scope — a call-scoped
        // pump would interrupt itself mid-cleanup. It exits when teardown ends
        // the codex event queue.
        yield* Queue.take(codexEvents).pipe(
          Effect.flatMap(handleCodexEvent),
          Effect.forever,
          Effect.ignore,
          Effect.forkDetach,
        );
        yield* Deferred.await(call.sdpReceived).pipe(
          Effect.timeoutOption(SDP_ANSWER_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                emit(call, {
                  type: "error",
                  liveSessionId,
                  message: "Codex did not produce an SDP answer in time.",
                }).pipe(Effect.andThen(teardown(liveSessionId, "realtime_start_timeout"))),
              onSome: () => Effect.void,
            }),
          ),
          Effect.forkDetach,
        );
        return call;
      }).pipe(
        Effect.onError(() =>
          teardown(liveSessionId, "start_failed").pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
            Effect.andThen(
              SynchronizedRef.update(state, (current) => {
                if (current.owners.get(ownerKey) !== liveSessionId) return current;
                const owners = new Map(current.owners);
                owners.delete(ownerKey);
                return { ...current, owners };
              }),
            ),
          ),
        ),
      );

      return Stream.unwrap(
        Effect.acquireRelease(Effect.succeed(record), () =>
          teardown(liveSessionId, "disconnected"),
        ).pipe(Effect.map((call) => Stream.fromQueue(call.queue))),
      );
    },
  );

  const stop: VoiceLiveService["Service"]["stop"] = Effect.fn("VoiceLiveService.stop")(
    function* (liveSessionId, owner) {
      const record = (yield* SynchronizedRef.get(state)).calls.get(liveSessionId);
      if (!record) return { stopped: false };
      if (!sameOwner(record.owner, owner)) {
        return yield* new VoiceLiveError({
          message: "Only the client that started this voice call may stop it.",
          code: "not_call_owner",
          liveSessionId,
        });
      }
      const stopped = yield* teardown(liveSessionId, "stopped");
      return { stopped };
    },
  );

  type RespondResolution =
    | { readonly kind: "unknown" }
    | { readonly kind: "not_owner" }
    | {
        readonly kind: "pending";
        readonly deferred: Deferred.Deferred<VoiceLiveRouteResult, VoiceLiveError>;
      };

  const respond: VoiceLiveService["Service"]["respond"] = Effect.fn("VoiceLiveService.respond")(
    function* (response, owner) {
      const resolved = yield* SynchronizedRef.modify(
        state,
        (current): readonly [RespondResolution, VoiceLiveState] => {
          const record = current.calls.get(response.liveSessionId);
          if (!record) return [{ kind: "unknown" }, current];
          if (!sameOwner(record.owner, owner)) {
            return [{ kind: "not_owner" }, current];
          }
          const pending = record.pending.get(response.requestId);
          if (!pending) return [{ kind: "unknown" }, current];
          const nextPending = new Map(record.pending);
          nextPending.delete(response.requestId);
          const calls = new Map(current.calls);
          calls.set(response.liveSessionId, { ...record, pending: nextPending });
          return [
            { kind: "pending", deferred: pending },
            { ...current, calls },
          ];
        },
      );
      switch (resolved.kind) {
        case "unknown":
          return { accepted: false };
        case "not_owner":
          return yield* new VoiceLiveError({
            message: "Only the client that started this voice call may answer its route requests.",
            code: "not_call_owner",
            liveSessionId: response.liveSessionId,
          });
        case "pending": {
          if (response.ok && response.result !== undefined) {
            yield* Deferred.succeed(resolved.deferred, response.result);
          } else {
            yield* Deferred.fail(
              resolved.deferred,
              new VoiceLiveError({
                message:
                  response.errorMessage ??
                  (response.ok
                    ? "The routing client returned no result."
                    : "The routed request failed."),
                code:
                  response.errorCode ?? (response.ok ? "malformed_route_response" : "route_failed"),
                liveSessionId: response.liveSessionId,
              }),
            );
          }
          return { accepted: true };
        }
      }
    },
  );

  const routeExecute: VoiceLiveService["Service"]["routeExecute"] = Effect.fn(
    "VoiceLiveService.routeExecute",
  )(function* (liveSessionId, request, options) {
    const timeoutMs =
      options?.timeoutMs ??
      (request.kind === "list_hosts"
        ? DEFAULT_LIST_HOSTS_TIMEOUT_MS
        : DEFAULT_EXECUTE_TOOL_TIMEOUT_MS);
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const deferred = yield* Deferred.make<VoiceLiveRouteResult, VoiceLiveError>();
    const registered = yield* SynchronizedRef.modify(state, (current) => {
      const record = current.calls.get(liveSessionId);
      if (!record) return [undefined, current] as const;
      const pending = new Map(record.pending);
      pending.set(requestId, deferred);
      const next = { ...record, pending };
      const calls = new Map(current.calls);
      calls.set(liveSessionId, next);
      return [next, { ...current, calls }] as const;
    });
    if (!registered) {
      return yield* new VoiceLiveError({
        message: "This voice call is no longer active.",
        code: "call_closed",
        liveSessionId,
      });
    }
    yield* emit(registered, {
      type: "routeRequest",
      liveSessionId,
      request:
        request.kind === "list_hosts"
          ? { kind: "list_hosts", requestId }
          : {
              kind: "execute_tool",
              requestId,
              targetEnvironmentId: request.targetEnvironmentId,
              toolName: request.toolName,
              arguments: request.arguments,
              timeoutMs,
            },
    });
    const removePending = SynchronizedRef.update(state, (current) => {
      const record = current.calls.get(liveSessionId);
      if (!record || !record.pending.has(requestId)) return current;
      const pending = new Map(record.pending);
      pending.delete(requestId);
      const calls = new Map(current.calls);
      calls.set(liveSessionId, { ...record, pending });
      return { ...current, calls };
    });
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new VoiceLiveError({
                message: `The routing client did not answer within ${timeoutMs}ms.`,
                code: "route_timeout",
                liveSessionId,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.ensuring(removePending),
    );
  });

  const resolveVoiceCredential: VoiceLiveService["Service"]["resolveVoiceCredential"] = Effect.fn(
    "VoiceLiveService.resolveVoiceCredential",
  )(function* (rawToken) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const liveSessionId = (yield* SynchronizedRef.get(state)).tokens.get(tokenHash);
    return liveSessionId === undefined ? undefined : { liveSessionId };
  });

  return VoiceLiveService.of({ start, stop, respond, routeExecute, resolveVoiceCredential });
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeWithOptions({
    openHost: (input) =>
      openCodexRealtimeHost(input).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });
});

export const layer = Layer.effect(VoiceLiveService, make);

/** Exposed for tests so no test ever spawns a real Codex. */
export const __testing = {
  make: makeWithOptions,
};
