import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  ServerSettings,
  type VoiceLiveStreamEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type {
  CodexRealtimeEvent,
  CodexRealtimeHost,
  CodexRealtimeStartParams,
  OpenCodexRealtimeHostInput,
} from "./CodexRealtimeHost.ts";
import * as VoiceLiveService from "./VoiceLiveService.ts";

const owner: VoiceLiveService.VoiceLiveOwner = {
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(1),
};
const otherOwner: VoiceLiveService.VoiceLiveOwner = {
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(2),
};

const defaultSettings = Schema.decodeUnknownSync(ServerSettings)({});

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

interface FakeHostState {
  input: OpenCodexRealtimeHostInput | undefined;
  startParams: CodexRealtimeStartParams | undefined;
  stopped: boolean;
  childKilled: boolean;
  opened: number;
}

const makeFakeHost = () => {
  const state: FakeHostState = {
    input: undefined,
    startParams: undefined,
    stopped: false,
    childKilled: false,
    opened: 0,
  };
  const openHost: VoiceLiveService.OpenVoiceRealtimeHost = (input) =>
    Effect.gen(function* () {
      state.input = input;
      state.opened += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.childKilled = true;
        }),
      );
      return {
        codexVersion: "0.150.0",
        start: (params) =>
          Effect.sync(() => {
            state.startParams = params;
          }),
        stop: Effect.sync(() => {
          state.stopped = true;
        }),
        appendText: () => Effect.void,
      } satisfies CodexRealtimeHost;
    });
  const emit = (event: CodexRealtimeEvent) => {
    state.input?.onEvent(event);
  };
  return { state, openHost, emit };
};

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HttpServer.HttpServer, fakeHttpServer),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-voice-live-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(defaultSettings) }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
);

const makeService = (openHost: VoiceLiveService.OpenVoiceRealtimeHost) =>
  VoiceLiveService.__testing.make({ openHost }).pipe(Effect.provide(dependencies));

const startCall = Effect.fn(function* (
  service: VoiceLiveService.VoiceLiveService["Service"],
  input?: { readonly crossHostRouting?: boolean },
  callOwner: VoiceLiveService.VoiceLiveOwner = owner,
) {
  const events = yield* Queue.unbounded<VoiceLiveStreamEvent>();
  const stream = yield* service.start({ offerSdp: "offer-sdp", ...input }, callOwner);
  const fiber = yield* Stream.runForEach(stream, (event) => Queue.offer(events, event)).pipe(
    Effect.forkChild,
  );
  const started = yield* Queue.take(events);
  assert.strictEqual(started.type, "started");
  return { events, fiber, started, liveSessionId: started.liveSessionId };
});

describe("VoiceLiveService", () => {
  it.effect("runs a call through started, answer, transcript, and terminal closed", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const { events, fiber, started, liveSessionId } = yield* startCall(service);
      assert.strictEqual(started.type === "started" && started.realtimeVersion, "0.150.0");
      assert.strictEqual(started.seq, 1);

      // The hidden session got the voice MCP endpoint plus a bearer token
      // whose hash resolves this call.
      const mcp = fake.state.input?.mcp;
      assert.ok(mcp);
      expect(mcp.endpoint).toBe("http://127.0.0.1:43123/mcp/voice");
      const rawToken = mcp.authorizationHeader.replace(/^Bearer\s+/, "");
      expect(rawToken.length).toBeGreaterThan(20);
      const credential = yield* service.resolveVoiceCredential(rawToken);
      assert.strictEqual(credential?.liveSessionId, liveSessionId);
      expect(fake.state.startParams?.prompt).toContain("chief of staff");

      fake.emit({ kind: "sdp", sdp: "answer-sdp" });
      const answer = yield* Queue.take(events);
      assert.ok(answer.type === "answer" && answer.sdp === "answer-sdp");
      assert.strictEqual(answer.seq, 2);

      fake.emit({ kind: "transcript", role: "assistant", text: "hello" });
      const transcript = yield* Queue.take(events);
      assert.ok(transcript.type === "transcript" && transcript.text === "hello");

      fake.emit({ kind: "closed", reason: "peer_hung_up" });
      const closed = yield* Queue.take(events);
      assert.ok(closed.type === "closed" && closed.reason === "peer_hung_up");

      // The stream ends after the terminal closed; teardown revoked the
      // credential and killed the child (call scope closed).
      yield* Fiber.join(fiber);
      assert.strictEqual(fake.state.childKilled, true);
      assert.strictEqual(fake.state.stopped, true);
      assert.strictEqual(yield* service.resolveVoiceCredential(rawToken), undefined);
    }),
  );

  it.effect("rejects a second call from the same owner while one is active", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service);
      const busy = yield* service.start({ offerSdp: "offer-sdp" }, owner).pipe(Effect.flip);
      assert.strictEqual(busy.code, "busy");
      // A different socket is not affected by this owner's call.
      const other = yield* startCall(service, {}, otherOwner);
      yield* Fiber.interrupt(other.fiber);
      yield* Fiber.interrupt(call.fiber);
    }),
  );

  it.effect("does not hand the MCP endpoint to Codex when crossHostRouting is off", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service, { crossHostRouting: false });
      assert.strictEqual(fake.state.input?.mcp, undefined);
      expect(fake.state.startParams?.prompt).toContain("no cross-environment routing");
      yield* Fiber.interrupt(call.fiber);
    }),
  );

  it.effect("tears down the call when the client's stream is interrupted", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service);
      const rawToken = fake.state.input!.mcp!.authorizationHeader.replace(/^Bearer\s+/, "");
      yield* Fiber.interrupt(call.fiber);
      assert.strictEqual(fake.state.childKilled, true);
      assert.strictEqual(yield* service.resolveVoiceCredential(rawToken), undefined);
      // The owner slot is free again.
      const next = yield* startCall(service);
      yield* Fiber.interrupt(next.fiber);
      assert.strictEqual(fake.state.opened, 2);
    }),
  );

  it.effect("respond resolves a pending routeExecute for the owning client", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service);

      const routeFiber = yield* service
        .routeExecute(call.liveSessionId, { kind: "list_hosts" })
        .pipe(Effect.forkChild);
      const routeEvent = yield* Queue.take(call.events);
      assert.ok(routeEvent.type === "routeRequest");
      assert.strictEqual(routeEvent.request.kind, "list_hosts");
      const requestId = routeEvent.request.requestId;

      const accepted = yield* service.respond(
        {
          liveSessionId: call.liveSessionId,
          requestId,
          ok: true,
          result: { kind: "list_hosts", hosts: [] },
        },
        owner,
      );
      assert.strictEqual(accepted.accepted, true);
      const result = yield* Fiber.join(routeFiber);
      assert.strictEqual(result.kind, "list_hosts");

      // A second answer to the same request is stale.
      const again = yield* service.respond(
        { liveSessionId: call.liveSessionId, requestId, ok: true },
        owner,
      );
      assert.strictEqual(again.accepted, false);
      yield* Fiber.interrupt(call.fiber);
    }),
  );

  it.effect("routeExecute fails with route_timeout when nobody answers", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service);
      const routeFiber = yield* service
        .routeExecute(call.liveSessionId, { kind: "list_hosts" })
        .pipe(Effect.flip, Effect.forkChild);
      const routeEvent = yield* Queue.take(call.events);
      assert.strictEqual(routeEvent.type, "routeRequest");
      yield* TestClock.adjust(Duration.millis(VoiceLiveService.DEFAULT_LIST_HOSTS_TIMEOUT_MS));
      const error = yield* Fiber.join(routeFiber);
      assert.strictEqual(error.code, "route_timeout");
      yield* Fiber.interrupt(call.fiber);
    }),
  );

  it.effect("stop is owner-checked and respond after teardown is not accepted", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const service = yield* makeService(fake.openHost);
      const call = yield* startCall(service);

      const routeFiber = yield* service
        .routeExecute(call.liveSessionId, { kind: "list_hosts" })
        .pipe(Effect.forkChild);
      const routeEvent = yield* Queue.take(call.events);
      assert.ok(routeEvent.type === "routeRequest");

      const denied = yield* service.stop(call.liveSessionId, otherOwner).pipe(Effect.flip);
      assert.strictEqual(denied.code, "not_call_owner");

      const stopped = yield* service.stop(call.liveSessionId, owner);
      assert.strictEqual(stopped.stopped, true);
      const closed = yield* Queue.take(call.events);
      assert.ok(closed.type === "closed" && closed.reason === "stopped");
      yield* Fiber.join(call.fiber);

      // Teardown failed the pending route request.
      const routeError = yield* Fiber.join(routeFiber).pipe(Effect.flip);
      assert.strictEqual(routeError.code, "call_closed");

      const late = yield* service.respond(
        {
          liveSessionId: call.liveSessionId,
          requestId: routeEvent.request.requestId,
          ok: false,
          errorCode: "host_offline",
        },
        owner,
      );
      assert.strictEqual(late.accepted, false);

      const secondStop = yield* service.stop(call.liveSessionId, owner);
      assert.strictEqual(secondStop.stopped, false);
    }),
  );
});
