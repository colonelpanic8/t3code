import {
  WS_METHODS,
  type EnvironmentId,
  type VoiceLiveHost,
  type VoiceLiveRouteRequest,
  type VoiceLiveRouteResponse,
  type VoiceLiveSessionId,
  type VoiceLiveStartInput,
  type VoiceLiveStopInput,
  type VoiceLiveStreamEvent,
  type VoiceLiveToolExecuteInput,
  type VoiceLiveTranscriptRole,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import {
  request,
  runStream,
  type EnvironmentRpcFailure,
  type EnvironmentRpcStreamFailure,
  type EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import {
  createRuntimeCommand,
  runAtomCommand,
  runInEnvironment,
  runStreamInEnvironment,
  type AtomCommandResult,
} from "./runtime.ts";
import {
  describeVoiceLiveFailure,
  routeVoiceLiveRequest,
  type VoiceLiveRouterDeps,
} from "./voiceLiveRouter.ts";

export * from "./voiceLiveRouter.ts";

/**
 * Shared Live Voice call driver. The platform (web/mobile) owns WebRTC media;
 * this module owns the `voice.live.start` stream: seq ordering, callback
 * fan-out, cross-host route handling, and best-effort stop. Nothing here
 * touches the DOM, so mobile reuses it unchanged.
 */

/** Drops stale or replayed events: `seq` is monotonically increasing per call. */
export interface VoiceLiveEventSequencer {
  readonly accept: (seq: number) => boolean;
}

export function createVoiceLiveEventSequencer(): VoiceLiveEventSequencer {
  let lastSeq = Number.MIN_SAFE_INTEGER;
  return {
    accept: (seq) => {
      if (seq <= lastSeq) {
        return false;
      }
      lastSeq = seq;
      return true;
    },
  };
}

export interface VoiceLiveTranscriptLine {
  readonly role: VoiceLiveTranscriptRole;
  readonly text: string;
}

export interface VoiceLiveCallCallbacks {
  readonly onStarted?: (info: {
    readonly liveSessionId: VoiceLiveSessionId;
    readonly realtimeVersion: string | null;
  }) => void;
  readonly onAnswer?: (sdp: string) => void;
  readonly onTranscript?: (line: VoiceLiveTranscriptLine) => void;
  readonly onError?: (message: string) => void;
  readonly onClosed?: (reason: string | null) => void;
}

export type VoiceLiveCallEnd =
  | { readonly type: "closed"; readonly reason: string | null }
  | { readonly type: "stopped" }
  | { readonly type: "ended" }
  | { readonly type: "failed"; readonly message: string };

export interface VoiceLiveCallDeps<R = never, E = never> extends VoiceLiveRouterDeps<R, E> {
  /** Runs the `voice.live.start` stream in the owning environment. */
  readonly runCallStream: (
    input: VoiceLiveStartInput,
  ) => Stream.Stream<VoiceLiveStreamEvent, E, R>;
  /** Answers a `routeRequest` back to the owning environment. */
  readonly respondRoute: (response: VoiceLiveRouteResponse) => Effect.Effect<unknown, E, R>;
  /** Best-effort `voice.live.stop` against the owning environment. */
  readonly stopCall: (input: VoiceLiveStopInput) => Effect.Effect<unknown, E, R>;
}

/**
 * Runs one Live Voice call to completion. Never fails: stream failures are
 * surfaced through `onError` and the returned end reason. Resolving
 * `options.stopSignal` interrupts the stream (tearing the call down
 * server-side) and then fires `voice.live.stop` best-effort.
 */
export function runVoiceLiveCall<R, E>(
  deps: VoiceLiveCallDeps<R, E>,
  input: VoiceLiveStartInput,
  callbacks: VoiceLiveCallCallbacks,
  options?: { readonly stopSignal?: Promise<void> },
): Effect.Effect<VoiceLiveCallEnd, never, R> {
  return Effect.gen(function* () {
    const sequencer = createVoiceLiveEventSequencer();
    let liveSessionId: VoiceLiveSessionId | null = null;
    let closed: VoiceLiveCallEnd | null = null;
    const routeFibers: Array<Fiber.Fiber<void>> = [];

    const respondToRoute = (
      sessionId: VoiceLiveSessionId,
      routeRequest: VoiceLiveRouteRequest,
    ): Effect.Effect<void, never, R> =>
      routeVoiceLiveRequest(routeRequest, deps).pipe(
        Effect.flatMap((outcome) =>
          deps.respondRoute({
            liveSessionId: sessionId,
            requestId: routeRequest.requestId,
            ok: outcome.ok,
            ...(outcome.ok
              ? { result: outcome.result }
              : { errorCode: outcome.errorCode, errorMessage: outcome.errorMessage }),
          }),
        ),
        Effect.ignore,
      );

    const handleEvent = (event: VoiceLiveStreamEvent): Effect.Effect<void, never, R> => {
      if (!sequencer.accept(event.seq)) {
        return Effect.void;
      }
      switch (event.type) {
        case "started":
          return Effect.sync(() => {
            liveSessionId = event.liveSessionId;
            callbacks.onStarted?.({
              liveSessionId: event.liveSessionId,
              realtimeVersion: event.realtimeVersion,
            });
          });
        case "answer":
          return Effect.sync(() => callbacks.onAnswer?.(event.sdp));
        case "transcript":
          return Effect.sync(() =>
            callbacks.onTranscript?.({ role: event.role, text: event.text }),
          );
        case "routeRequest":
          // Forked (detached from the stream fiber) so a slow routed tool
          // cannot stall answer/transcript delivery and so an in-flight
          // response survives the stream ending first. Drained or interrupted
          // below before the call settles.
          return respondToRoute(event.liveSessionId, event.request).pipe(
            Effect.forkDetach,
            Effect.map((fiber) => {
              routeFibers.push(fiber);
            }),
          );
        case "error":
          return Effect.sync(() => callbacks.onError?.(event.message));
        case "closed":
          return Effect.sync(() => {
            closed = { type: "closed", reason: event.reason };
            callbacks.onClosed?.(event.reason);
          });
      }
    };

    const consume: Effect.Effect<VoiceLiveCallEnd, never, R> = Stream.runForEach(
      deps.runCallStream(input),
      handleEvent,
    ).pipe(
      Effect.map((): VoiceLiveCallEnd => closed ?? { type: "ended" }),
      Effect.catchCause((cause) =>
        Effect.sync((): VoiceLiveCallEnd => {
          const message = describeVoiceLiveFailure(cause);
          callbacks.onError?.(message);
          return { type: "failed", message };
        }),
      ),
    );

    const outcome =
      options?.stopSignal === undefined
        ? yield* consume
        : yield* Effect.raceFirst(
            consume,
            Effect.promise(() => options.stopSignal!).pipe(
              Effect.as<VoiceLiveCallEnd>({ type: "stopped" }),
            ),
          );

    if (outcome.type === "stopped") {
      // Pending routes fail server-side on teardown; do not hold the stop.
      yield* Fiber.interruptAll(routeFibers);
      if (liveSessionId !== null) {
        yield* deps.stopCall({ liveSessionId }).pipe(Effect.ignore);
      }
    } else {
      yield* Effect.ignore(Fiber.awaitAll(routeFibers));
    }
    return outcome;
  });
}

/** Maps a connected environment onto the sanitized host shape the voice model sees. */
export function voiceLiveHostFromPresentation(
  environmentId: EnvironmentId,
  presentation: EnvironmentPresentation,
): VoiceLiveHost {
  return {
    environmentId,
    label: presentation.entry.target.label || environmentId,
    online: presentation.connection.phase === "connected",
    toolExecutionSupported:
      presentation.serverConfig?.environment.capabilities.voiceLiveToolExecution === true,
  };
}

export function voiceLiveHostsFromPresentations(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): ReadonlyArray<VoiceLiveHost> {
  return [...presentations].map(([environmentId, presentation]) =>
    voiceLiveHostFromPresentation(environmentId, presentation),
  );
}

export type EnvironmentVoiceLiveError =
  | EnvironmentRpcStreamFailure<typeof WS_METHODS.voiceLiveStart>
  | EnvironmentRpcFailure<typeof WS_METHODS.voiceLiveRouteRespond>
  | EnvironmentRpcFailure<typeof WS_METHODS.voiceLiveStop>
  | EnvironmentRpcFailure<typeof WS_METHODS.voiceLiveToolExecute>
  | EnvironmentRpcUnavailableError
  | EnvironmentNotRegisteredError;

export function makeEnvironmentVoiceLiveCallDeps(input: {
  readonly environmentId: EnvironmentId;
  readonly listHosts: () => ReadonlyArray<VoiceLiveHost>;
}): VoiceLiveCallDeps<EnvironmentRegistry, EnvironmentVoiceLiveError> {
  return {
    runCallStream: (startInput) =>
      runStreamInEnvironment(input.environmentId, runStream(WS_METHODS.voiceLiveStart, startInput)),
    respondRoute: (response) =>
      runInEnvironment(input.environmentId, request(WS_METHODS.voiceLiveRouteRespond, response)),
    stopCall: (stopInput) =>
      runInEnvironment(input.environmentId, request(WS_METHODS.voiceLiveStop, stopInput)),
    listHosts: Effect.sync(input.listHosts),
    executeTool: (targetEnvironmentId: EnvironmentId, toolInput: VoiceLiveToolExecuteInput) =>
      runInEnvironment(targetEnvironmentId, request(WS_METHODS.voiceLiveToolExecute, toolInput)),
  };
}

export interface StartVoiceLiveCallInput {
  /** Environment that hosts the call (must advertise the `voiceLive` capability). */
  readonly environmentId: EnvironmentId;
  readonly offerSdp: string;
  readonly voice?: string;
  readonly crossHostRouting?: boolean;
  /** Snapshot of the client's environments, used to answer route requests. */
  readonly listHosts: () => ReadonlyArray<VoiceLiveHost>;
}

export interface VoiceLiveCallHandle {
  /** Settles when the call is over, however it ended. */
  readonly result: Promise<AtomCommandResult<VoiceLiveCallEnd, unknown>>;
  /** Interrupts the stream and fires `voice.live.stop` best-effort. */
  readonly stop: () => void;
}

export function createVoiceLiveCallDriver<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  interface CallCommandInput {
    readonly call: StartVoiceLiveCallInput;
    readonly callbacks: VoiceLiveCallCallbacks;
    readonly stopSignal: Promise<void>;
  }
  const command = createRuntimeCommand(runtime, {
    label: "environment-data:voice-live:call",
    execute: ({ call, callbacks, stopSignal }: CallCommandInput) =>
      runVoiceLiveCall(
        makeEnvironmentVoiceLiveCallDeps({
          environmentId: call.environmentId,
          listHosts: call.listHosts,
        }),
        {
          offerSdp: call.offerSdp,
          ...(call.voice === undefined ? {} : { voice: call.voice }),
          ...(call.crossHostRouting === undefined
            ? {}
            : { crossHostRouting: call.crossHostRouting }),
        },
        callbacks,
        { stopSignal },
      ),
  });

  const startVoiceLiveCall = (
    registry: AtomRegistry.AtomRegistry,
    call: StartVoiceLiveCallInput,
    callbacks: VoiceLiveCallCallbacks,
  ): VoiceLiveCallHandle => {
    let requestStop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      requestStop = resolve;
    });
    const result = runAtomCommand(registry, command, { call, callbacks, stopSignal });
    return { result, stop: requestStop };
  };

  return { startVoiceLiveCall };
}
