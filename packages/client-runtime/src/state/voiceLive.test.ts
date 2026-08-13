import {
  EnvironmentId,
  type VoiceLiveHost,
  type VoiceLiveRouteRequest,
  type VoiceLiveRouteResponse,
  type VoiceLiveStopInput,
  type VoiceLiveStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  createVoiceLiveEventSequencer,
  runVoiceLiveCall,
  type VoiceLiveCallDeps,
  type VoiceLiveTranscriptLine,
} from "./voiceLive.ts";
import { classifyVoiceLiveExecuteTarget, routeVoiceLiveRequest } from "./voiceLiveRouter.ts";

class TestRpcError extends Schema.TaggedErrorClass<TestRpcError>()("TestRpcError", {
  message: Schema.String,
}) {}

const ENV_A = EnvironmentId.make("environment-a");
const ENV_B = EnvironmentId.make("environment-b");
const ENV_C = EnvironmentId.make("environment-c");

const HOSTS: ReadonlyArray<VoiceLiveHost> = [
  { environmentId: ENV_A, label: "Laptop", online: true, toolExecutionSupported: true },
  { environmentId: ENV_B, label: "Desktop", online: false, toolExecutionSupported: true },
  { environmentId: ENV_C, label: "Server", online: true, toolExecutionSupported: false },
];

describe("voice live event sequencer", () => {
  it("accepts strictly increasing seq and drops replays", () => {
    const sequencer = createVoiceLiveEventSequencer();
    expect(sequencer.accept(1)).toBe(true);
    expect(sequencer.accept(2)).toBe(true);
    expect(sequencer.accept(2)).toBe(false);
    expect(sequencer.accept(1)).toBe(false);
    expect(sequencer.accept(3)).toBe(true);
  });
});

describe("voice live router", () => {
  const executeToolUnused = () =>
    Effect.die(new Error("executeTool must not run for this request"));

  it("classifies unknown, offline, and unsupported targets", () => {
    expect(classifyVoiceLiveExecuteTarget(HOSTS, EnvironmentId.make("environment-x"))).toMatchObject(
      { ok: false, errorCode: "unknown_host" },
    );
    expect(classifyVoiceLiveExecuteTarget(HOSTS, ENV_B)).toMatchObject({
      ok: false,
      errorCode: "host_offline",
    });
    expect(classifyVoiceLiveExecuteTarget(HOSTS, ENV_C)).toMatchObject({
      ok: false,
      errorCode: "tool_execution_unsupported",
    });
    expect(classifyVoiceLiveExecuteTarget(HOSTS, ENV_A)).toMatchObject({ ok: true });
  });

  it.effect("answers list_hosts with the sanitized host snapshot", () =>
    Effect.gen(function* () {
      const outcome = yield* routeVoiceLiveRequest(
        { kind: "list_hosts", requestId: "route-1" },
        { listHosts: Effect.succeed(HOSTS), executeTool: executeToolUnused },
      );
      expect(outcome).toEqual({ ok: true, result: { kind: "list_hosts", hosts: HOSTS } });
    }));

  it.effect("fails execute_tool without running the tool when the target is not eligible", () =>
    Effect.gen(function* () {
      const request: VoiceLiveRouteRequest = {
        kind: "execute_tool",
        requestId: "route-2",
        targetEnvironmentId: ENV_B,
        toolName: "list_projects",
        arguments: {},
        timeoutMs: 1_000,
      };
      const outcome = yield* routeVoiceLiveRequest(request, {
        listHosts: Effect.succeed(HOSTS),
        executeTool: executeToolUnused,
      });
      expect(outcome).toMatchObject({ ok: false, errorCode: "host_offline" });
    }));

  it.effect("returns the tool result for an eligible target", () =>
    Effect.gen(function* () {
      const outcome = yield* routeVoiceLiveRequest(
        {
          kind: "execute_tool",
          requestId: "route-3",
          targetEnvironmentId: ENV_A,
          toolName: "list_projects",
          arguments: { limit: 3 },
          timeoutMs: 1_000,
        },
        {
          listHosts: Effect.succeed(HOSTS),
          executeTool: (environmentId, input) =>
            Effect.succeed({ result: { echoed: [environmentId, input.toolName] }, isError: false }),
        },
      );
      expect(outcome).toEqual({
        ok: true,
        result: {
          kind: "execute_tool",
          targetEnvironmentId: ENV_A,
          result: { echoed: [ENV_A, "list_projects"] },
          isError: false,
        },
      });
    }));

  it.effect("maps a failing target request to target_request_failed", () =>
    Effect.gen(function* () {
      const outcome = yield* routeVoiceLiveRequest(
        {
          kind: "execute_tool",
          requestId: "route-4",
          targetEnvironmentId: ENV_A,
          toolName: "list_projects",
          arguments: {},
          timeoutMs: 1_000,
        },
        {
          listHosts: Effect.succeed(HOSTS),
          executeTool: () => Effect.fail(new TestRpcError({ message: "socket closed" })),
        },
      );
      expect(outcome).toEqual({
        ok: false,
        errorCode: "target_request_failed",
        errorMessage: "socket closed",
      });
    }));

  it.effect("maps a target timeout to target_request_failed", () =>
    Effect.gen(function* () {
      const fiber = yield* routeVoiceLiveRequest(
        {
          kind: "execute_tool",
          requestId: "route-5",
          targetEnvironmentId: ENV_A,
          toolName: "list_projects",
          arguments: {},
          timeoutMs: 50,
        },
        {
          listHosts: Effect.succeed(HOSTS),
          executeTool: () => Effect.never,
        },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("100 millis");
      const outcome = yield* Fiber.join(fiber);
      expect(outcome).toMatchObject({ ok: false, errorCode: "target_request_failed" });
    }));
});

function event(partial: VoiceLiveStreamEvent): VoiceLiveStreamEvent {
  return partial;
}

function makeDeps(input: {
  readonly events: ReadonlyArray<VoiceLiveStreamEvent>;
  readonly endless?: boolean;
  readonly responses?: Array<VoiceLiveRouteResponse>;
  readonly stops?: Array<VoiceLiveStopInput>;
}): VoiceLiveCallDeps<never, TestRpcError> {
  const stream = Stream.fromArray(input.events);
  return {
    runCallStream: () => (input.endless === true ? Stream.concat(stream, Stream.never) : stream),
    respondRoute: (response) =>
      Effect.sync(() => {
        input.responses?.push(response);
      }),
    stopCall: (stop) =>
      Effect.sync(() => {
        input.stops?.push(stop);
      }),
    listHosts: Effect.succeed(HOSTS),
    executeTool: () => Effect.succeed({ result: "ok" }),
  };
}

describe("runVoiceLiveCall", () => {
  it.effect("orders events by seq, drops replays, and surfaces the closed reason", () =>
    Effect.gen(function* () {
      const transcripts: Array<VoiceLiveTranscriptLine> = [];
      const answers: Array<string> = [];
      const closes: Array<string | null> = [];
      const end = yield* runVoiceLiveCall(
        makeDeps({
          events: [
            event({
              type: "started",
              seq: 1,
              liveSessionId: "session-1",
              realtimeVersion: "v3",
            }),
            event({ type: "answer", seq: 2, liveSessionId: "session-1", sdp: "answer-sdp" }),
            // Replayed seq: must be dropped.
            event({
              type: "transcript",
              seq: 2,
              liveSessionId: "session-1",
              role: "user",
              text: "stale",
            }),
            event({
              type: "transcript",
              seq: 3,
              liveSessionId: "session-1",
              role: "assistant",
              text: "hello",
            }),
            event({ type: "closed", seq: 4, liveSessionId: "session-1", reason: "hangup" }),
          ],
        }),
        { offerSdp: "offer-sdp" },
        {
          onAnswer: (sdp) => answers.push(sdp),
          onTranscript: (line) => transcripts.push(line),
          onClosed: (reason) => closes.push(reason),
        },
      );
      expect(answers).toEqual(["answer-sdp"]);
      expect(transcripts).toEqual([{ role: "assistant", text: "hello" }]);
      expect(closes).toEqual(["hangup"]);
      expect(end).toEqual({ type: "closed", reason: "hangup" });
    }));

  it.effect("answers route requests through the router back to the owning environment", () =>
    Effect.gen(function* () {
      const responses: Array<VoiceLiveRouteResponse> = [];
      const end = yield* runVoiceLiveCall(
        makeDeps({
          events: [
            event({
              type: "started",
              seq: 1,
              liveSessionId: "session-2",
              realtimeVersion: null,
            }),
            event({
              type: "routeRequest",
              seq: 2,
              liveSessionId: "session-2",
              request: { kind: "list_hosts", requestId: "route-a" },
            }),
            event({
              type: "routeRequest",
              seq: 3,
              liveSessionId: "session-2",
              request: {
                kind: "execute_tool",
                requestId: "route-b",
                targetEnvironmentId: EnvironmentId.make("environment-x"),
                toolName: "list_projects",
                arguments: {},
                timeoutMs: 1_000,
              },
            }),
            event({ type: "closed", seq: 4, liveSessionId: "session-2", reason: null }),
          ],
          responses,
        }),
        { offerSdp: "offer-sdp" },
        {},
      );
      expect(end).toEqual({ type: "closed", reason: null });
      expect(responses).toHaveLength(2);
      expect(responses.find((response) => response.requestId === "route-a")).toEqual({
        liveSessionId: "session-2",
        requestId: "route-a",
        ok: true,
        result: { kind: "list_hosts", hosts: HOSTS },
      });
      expect(responses.find((response) => response.requestId === "route-b")).toMatchObject({
        liveSessionId: "session-2",
        requestId: "route-b",
        ok: false,
        errorCode: "unknown_host",
      });
    }));

  it.effect("stop interrupts the stream and fires voice.live.stop best-effort", () =>
    Effect.gen(function* () {
      const stops: Array<VoiceLiveStopInput> = [];
      let requestStop!: () => void;
      const stopSignal = new Promise<void>((resolve) => {
        requestStop = resolve;
      });
      const end = yield* runVoiceLiveCall(
        makeDeps({
          events: [
            event({
              type: "started",
              seq: 1,
              liveSessionId: "session-3",
              realtimeVersion: null,
            }),
          ],
          endless: true,
          stops,
        }),
        { offerSdp: "offer-sdp" },
        { onStarted: () => requestStop() },
        { stopSignal },
      );
      expect(end).toEqual({ type: "stopped" });
      expect(stops).toEqual([{ liveSessionId: "session-3" }]);
    }));

  it.effect("surfaces stream failures as a failed end and onError", () =>
    Effect.gen(function* () {
      const errors: Array<string> = [];
      const deps = makeDeps({ events: [] });
      const end = yield* runVoiceLiveCall(
        {
          ...deps,
          runCallStream: () => Stream.fail(new TestRpcError({ message: "codex_too_old" })),
        },
        { offerSdp: "offer-sdp" },
        { onError: (message) => errors.push(message) },
      );
      expect(end).toEqual({ type: "failed", message: "codex_too_old" });
      expect(errors).toEqual(["codex_too_old"]);
    }));
});
