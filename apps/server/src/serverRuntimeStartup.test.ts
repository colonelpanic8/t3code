import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";

it.effect("runs projection repair, recovery, worker startup, and bootstrap in order", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      verify: record("verify").pipe(Effect.as({ valid: false })),
      rebuild: record("rebuild").pipe(Effect.as({ valid: true })),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "verify",
      "rebuild",
      "recover",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("does not rebuild valid projections", () =>
  Effect.gen(function* () {
    const rebuilt = yield* Ref.make(false);
    yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: Effect.void,
      verify: Effect.succeed({ valid: true }),
      rebuild: Ref.set(rebuilt, true).pipe(Effect.as({ valid: true })),
      recover: Effect.void,
      startEffectWorker: Effect.void,
      autoBootstrap: Effect.void,
    });
    assert.isFalse(yield* Ref.get(rebuilt));
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string, autoPull = true) =>
      ({
        id: ProjectId.make(workspaceRoot),
        workspaceRoot,
        autoPull,
      }) as never;

    yield* ServerRuntimeStartup.autoPullProjects([
      project("/clean"),
      project("/current"),
      project("/dirty"),
      project("/ahead"),
      project("/feature"),
      project("/disabled", false),
    ]).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited", false), project("/opted-out"), project("/dirty", false)],
      {
        defaultAutoPull: true,
        projectAutoPullOverrides: { [ProjectId.make("/opted-out")]: false },
      },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect("auto-bootstrap uses machine defaults and reports what it created", () => {
  const projectId = ProjectId.make("project:auto-bootstrap-v2");
  const threadId = ThreadId.make("thread:auto-bootstrap-v2");
  const machineSelection = {
    instanceId: ProviderInstanceId.make("claude-code"),
    model: "claude-sonnet-4-6",
  };
  const launch = vi.fn((_input: ThreadLaunch.ThreadLaunchInput) =>
    Effect.succeed({ threadId, projection: {}, resumed: false } as never),
  );
  const project = {
    id: projectId,
    title: "Startup Project",
    workspaceRoot: "/tmp/startup-project",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest({ defaultModelSelection: machineSelection }),
    Layer.succeed(ServerConfig.ServerConfig, {
      cwd: project.workspaceRoot,
      autoBootstrapProjectFromCwd: true,
    } as never),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: () => Effect.succeed({ project, created: true }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch }),
  );

  return Effect.gen(function* () {
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets;
    assert.deepStrictEqual(targets, {
      bootstrapProjectId: projectId,
      bootstrapThreadId: threadId,
      bootstrapProjectCreated: true,
      bootstrapThreadCreated: true,
    });
    assert.deepStrictEqual(launch.mock.calls[0]?.[0].modelSelection, machineSelection);
  }).pipe(Effect.provide(layer));
});

it.effect("auto-bootstrap preserves a project created before thread launch fails", () => {
  const projectId = ProjectId.make("project:auto-bootstrap-thread-failure");
  const project = {
    id: projectId,
    title: "Startup Project",
    workspaceRoot: "/tmp/startup-project",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.succeed(ServerConfig.ServerConfig, {
      cwd: project.workspaceRoot,
      autoBootstrapProjectFromCwd: true,
    } as never),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: () => Effect.succeed({ project, created: true }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: () => Effect.die("thread launch failed"),
    }),
  );

  return Effect.gen(function* () {
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets;
    assert.deepStrictEqual(targets, {
      bootstrapProjectId: projectId,
      bootstrapProjectCreated: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("completeAutoBootstrapWelcome settles bootstrap failures", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.die("bootstrap failed"),
    );
    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome preserves successful targets", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.succeed({
        bootstrapProjectId: ProjectId.make("project:existing"),
      }),
    );
    assert.deepStrictEqual(completion, {
      bootstrapProjectId: ProjectId.make("project:existing"),
      bootstrapStatus: "complete",
    });
  }),
);
