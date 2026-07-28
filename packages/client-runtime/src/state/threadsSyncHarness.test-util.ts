/**
 * Test harness for driving the environment thread state machine with a fake
 * socket, cache, and snapshot loader. Adapted from the inline harness in
 * threads-sync.test.ts so perf/repro tests can reuse it; the filename avoids
 * the `.test.ts` suffix so it is not collected as a suite itself.
 */
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
export const HARNESS_THREAD_ID = ThreadId.make("thread-1");
export const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

export type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      options?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

export const makeThreadSyncHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(
  function* (options?: {
    readonly cached?: OrchestrationThread;
    readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
    readonly completionMarker?: boolean;
  }) {
    const inputs = yield* Queue.unbounded<TestThreadInput>();
    const observed = yield* Queue.unbounded<EnvironmentThreadState>();
    const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
    const retryCount = yield* Ref.make(0);
    const subscriptionCount = yield* Ref.make(0);
    const loaderCalls = yield* Ref.make(0);
    const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
    const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
    const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
    const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
    const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
      Stream.fromQueue(queue).pipe(
        Stream.mapEffect((input) =>
          input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
        ),
      );
    const client = {
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
        readonly afterSequence?: number;
        readonly requestCompletionMarker?: boolean;
      }) =>
        Stream.unwrap(
          Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
            Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
            Effect.andThen(Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker)),
            Effect.as(streamFrom(inputs)),
          ),
        ),
    } as unknown as WsRpcProtocolClient;
    const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.some(
        testSession(
          client,
          options?.completionMarker === true ? { completionMarker: true } : undefined,
        ),
      ),
    );
    const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some(PREPARED),
    );
    const snapshotLoader = ThreadSnapshotLoader.of({
      load: (_prepared, threadId) =>
        Ref.update(loaderCalls, (count) => count + 1).pipe(
          Effect.as(
            threadId === HARNESS_THREAD_ID
              ? (options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>())
              : Option.none<OrchestrationThreadDetailSnapshot>(),
          ),
        ),
    });
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session: supervisorSession,
      prepared,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Ref.update(retryCount, (count) => count + 1),
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeed(Option.none()),
      saveShell: () => Effect.void,
      loadThread: (_environmentId, threadId) =>
        Effect.succeed(
          threadId === HARNESS_THREAD_ID && options?.cached !== undefined
            ? Option.some({
                snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                thread: options.cached,
              })
            : Option.none(),
        ),
      saveThread: (_environmentId, thread) =>
        Ref.update(savedThreads, (current) => [...current, thread]),
      removeThread: (_environmentId, threadId) =>
        Ref.update(removedThreads, (current) => [...current, threadId]),
      loadServerConfig: () => Effect.succeed(Option.none()),
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeed(Option.none()),
      saveVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const threadState = yield* makeEnvironmentThreadState(HARNESS_THREAD_ID).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
      Effect.provideService(
        ConnectionWakeups.ConnectionWakeups,
        ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
      ),
    );
    yield* SubscriptionRef.changes(threadState).pipe(
      Stream.runForEach((state) =>
        Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
      ),
      Effect.forkScoped,
    );

    return {
      inputs,
      observed,
      latest,
      retryCount,
      subscriptionCount,
      loaderCalls,
      lastSubscribeAfterSequence,
      lastRequestCompletionMarker,
      supervisorState,
      supervisorSession,
      savedThreads,
      removedThreads,
      wakeups,
      replaceSession: SubscriptionRef.set(
        supervisorSession,
        Option.some(
          testSession(
            client,
            options?.completionMarker === true ? { completionMarker: true } : undefined,
          ),
        ),
      ),
    };
  },
);
