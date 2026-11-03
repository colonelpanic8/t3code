import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  assistantRequestIds,
  parseAssistantRequestJob,
  resolveModelSelection,
  runAssistantRequest,
  type AssistantEnvironmentClient,
  type AssistantEnvironmentConnection,
  type AssistantRequestJob,
  type AssistantRequestPlan,
  type AssistantRequestUpdate,
  type DispatchOutcome,
} from "./assistant-requests";

const KEY = "a".repeat(32) + "b".repeat(32);
const NOW = new Date("2026-10-18T12:00:00.000Z");
const environmentId = EnvironmentId.make("env-1");

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    enabled: true,
    status: "ready",
    models: [
      { slug: "gpt-a", name: "A", isCustom: false },
      { slug: "gpt-b", name: "B", isCustom: false, isDefault: true },
    ],
    ...overrides,
  } as ServerProvider;
}

const project = {
  environmentId,
  id: ProjectId.make("proj-1"),
  title: "t3code",
  workspaceRoot: "/src/t3code",
  defaultModelSelection: null,
} as unknown as EnvironmentProject;

function fakeClient(outcome: DispatchOutcome = { kind: "accepted" }) {
  const dispatched: AssistantRequestPlan[] = [];
  const environment: AssistantEnvironmentClient = {
    environmentName: "ryzen-shine",
    project: (id) => (id === project.id ? project : null),
    thread: (id) =>
      id === "thread-1"
        ? makeThreadShellFixture({
            environmentId,
            id: ThreadId.make("thread-1"),
            title: "Fix login",
            runtimeMode: "approval-required",
            interactionMode: "plan",
          })
        : null,
    providers: () => [provider()],
    currentBranch: async () => "main",
    newWorktreeBranchName: () => "t3code/feedbeef",
    startThread: async (plan) => {
      dispatched.push(plan);
      return outcome;
    },
    sendMessage: async (plan) => {
      dispatched.push(plan);
      return outcome;
    },
    threadProjection: async () => null,
    prepareWorkspace: async () => ({ kind: "definite", message: "unused" }),
    dispatchThreadAction: async (plan) => {
      dispatched.push(plan);
      return outcome;
    },
  };
  return { environment, dispatched };
}

/** A journal that stores the first plan and reports state like the native rules. */
function fakeJournal(initial: { state?: string; plan?: AssistantRequestPlan } = {}) {
  const updates: AssistantRequestUpdate[] = [];
  let stored: { state: string; plan: AssistantRequestPlan | undefined } = {
    state: initial.state ?? "accepted",
    plan: initial.plan,
  };
  return {
    updates,
    report: async (update: AssistantRequestUpdate) => {
      updates.push(update);
      if (stored.state === "accepted" || stored.state === "waiting_for_host") {
        stored = { state: update.state ?? stored.state, plan: stored.plan ?? update.plan };
      }
      return stored;
    },
  };
}

function job(overrides: Partial<AssistantRequestJob> = {}): AssistantRequestJob {
  return {
    key: KEY,
    operation: "start_thread",
    arguments: { environmentId, projectId: "proj-1", prompt: "Fix the login bug" },
    plan: null,
    dispatchStarted: false,
    ...overrides,
  };
}

async function run(
  requestJob: AssistantRequestJob,
  connection: AssistantEnvironmentConnection,
  journal = fakeJournal(),
) {
  await runAssistantRequest(requestJob, {
    connect: async () => connection,
    report: journal.report,
    now: () => NOW,
  });
  return journal.updates;
}

describe("runAssistantRequest", () => {
  it("journals the plan with deterministic ids before starting the thread", async () => {
    const { environment, dispatched } = fakeClient();
    const updates = await run(job(), { kind: "connected", environment });
    const ids = assistantRequestIds(KEY);

    expect(updates[0]).toMatchObject({
      state: "accepted",
      dispatchStarted: true,
      threadId: ids.threadId,
    });
    expect(dispatched).toEqual([updates[0]?.plan]);
    expect(dispatched[0]).toMatchObject({
      ...ids,
      title: "Fix the login bug",
      modelSelection: { instanceId: "codex", model: "gpt-b" },
      runtimeMode: "full-access",
      workspace: { mode: "local", branch: null },
    });
    expect(updates[1]).toMatchObject({
      state: "completed",
      threadId: ids.threadId,
      catalog: {
        thread: { id: ids.threadId, projectName: "t3code", environmentName: "ryzen-shine" },
      },
    });
  });

  it("replays a saved plan unchanged instead of planning again", async () => {
    const { environment, dispatched } = fakeClient();
    const { environment: planner } = fakeClient();
    const saved = fakeJournal();
    await run(job(), { kind: "connected", environment: planner }, saved);
    const plan = saved.updates[0]?.plan;

    const updates = await run(job({ plan, dispatchStarted: true }), {
      kind: "connected",
      environment,
    });

    expect(dispatched).toEqual([plan]);
    expect(updates.map((update) => update.state)).toEqual(["completed"]);
  });

  it("dispatches what the journal holds when another run committed first", async () => {
    const { environment, dispatched } = fakeClient();
    const { environment: other } = fakeClient();
    const earlier = fakeJournal();
    await run(
      job({ arguments: { ...(job().arguments as object), prompt: "Earlier" } }),
      {
        kind: "connected",
        environment: other,
      },
      earlier,
    );
    const firstPlan = earlier.updates[0]?.plan;

    await run(job(), { kind: "connected", environment }, fakeJournal({ plan: firstPlan }));

    expect(dispatched).toEqual([firstPlan]);
  });

  it("does not dispatch once the journal settled the request", async () => {
    const { environment, dispatched } = fakeClient();
    await run(job(), { kind: "connected", environment }, fakeJournal({ state: "completed" }));
    expect(dispatched).toEqual([]);
  });

  it("leaves a lost reply pending and settles a server rejection", async () => {
    const lost = await run(job(), {
      kind: "connected",
      environment: fakeClient({ kind: "transient", message: "socket closed" }).environment,
    });
    expect(lost.map((update) => update.state)).toEqual(["accepted"]);

    const rejected = await run(job(), {
      kind: "connected",
      environment: fakeClient({ kind: "definite", message: "Project is archived." }).environment,
    });
    expect(rejected[1]).toEqual({
      state: "failed",
      error: { code: "rejected", message: "Project is archived." },
    });
  });

  it.each([
    [{ kind: "unknown_environment" } as const, "rejected", "unknown_environment"],
    [
      { kind: "offline", environmentName: "laptop" } as const,
      "waiting_for_host",
      "environment_offline",
    ],
    [
      { kind: "needs_sign_in", environmentName: "cloud" } as const,
      "needs_configuration",
      "sign_in_required",
    ],
  ])("reports %o without dispatching", async (connection, state, code) => {
    const updates = await run(job(), connection);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ state, error: { code } });
  });

  it("rejects an unknown project before dispatching", async () => {
    const { environment, dispatched } = fakeClient();
    const updates = await run(
      job({ arguments: { environmentId, projectId: "nope", prompt: "x" } }),
      {
        kind: "connected",
        environment,
      },
    );
    expect(dispatched).toEqual([]);
    expect(updates[0]).toMatchObject({ state: "rejected", error: { code: "unknown_project" } });
  });

  it("starts a worktree from the project's current branch", async () => {
    const { environment, dispatched } = fakeClient();
    await run(
      job({
        arguments: { environmentId, projectId: "proj-1", prompt: "x", workspace: "worktree" },
      }),
      { kind: "connected", environment },
    );
    expect(dispatched[0]).toMatchObject({
      workspace: {
        mode: "worktree",
        projectCwd: "/src/t3code",
        baseBranch: "main",
        branch: "t3code/feedbeef",
      },
    });
  });

  it("sends to an existing thread with its own modes, steering by default", async () => {
    const { environment, dispatched } = fakeClient();
    const updates = await run(
      job({
        operation: "send_message",
        arguments: { environmentId, threadId: "thread-1", prompt: "Also add tests" },
      }),
      { kind: "connected", environment },
    );
    expect(dispatched[0]).toMatchObject({
      kind: "send_message",
      threadId: "thread-1",
      commandId: assistantRequestIds(KEY).commandId,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      dispatchMode: "steer",
    });
    expect(updates[1]).toEqual({ state: "completed", threadId: "thread-1" });
  });

  it("journals and dispatches thread actions, completing with their summary", async () => {
    const { environment, dispatched } = fakeClient();
    const updates = await run(
      job({
        operation: "rename_thread",
        arguments: { environmentId, threadId: "thread-1", title: "Login fix" },
      }),
      { kind: "connected", environment },
    );
    expect(dispatched).toEqual([
      expect.objectContaining({ kind: "rename_thread", title: "Login fix" }),
    ]);
    expect(updates[0]).toMatchObject({ dispatchStarted: true, state: "accepted" });
    expect(updates[1]?.state).toBe("completed");
    expect(updates[1]?.summary).toMatch(/^Renamed .* to “Login fix” on ryzen-shine\.$/);
  });
});

describe("resolveModelSelection", () => {
  const providers = [
    provider({ instanceId: ProviderInstanceId.make("claude"), status: "error" }),
    provider(),
  ];

  it("prefers the request, then the project default, then the first ready provider", () => {
    expect(
      resolveModelSelection({ provider: "codex", model: "gpt-a", projectDefault: null, providers }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-a",
    });
    expect(
      resolveModelSelection({
        projectDefault: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
        providers,
      }),
    ).toEqual({ instanceId: "claude", model: "opus" });
    expect(resolveModelSelection({ projectDefault: null, providers })).toEqual({
      instanceId: "codex",
      model: "gpt-b",
    });
  });

  it("rejects providers and models the environment cannot run", () => {
    expect(() =>
      resolveModelSelection({ provider: "nope", projectDefault: null, providers }),
    ).toThrow(/not enabled/);
    expect(() =>
      resolveModelSelection({ provider: "claude", projectDefault: null, providers }),
    ).toThrow(/reports an error/);
    expect(() =>
      resolveModelSelection({ provider: "codex", model: "gpt-z", projectDefault: null, providers }),
    ).toThrow(/not offered/);
  });
});

describe("parseAssistantRequestJob", () => {
  it("drops malformed task data whole", () => {
    const valid = {
      key: KEY,
      operation: "send_message",
      arguments: "{}",
      plan: "",
      dispatchStarted: "false",
    };
    expect(parseAssistantRequestJob(valid)).toMatchObject({ plan: null, dispatchStarted: false });
    expect(parseAssistantRequestJob({ ...valid, plan: '{"kind":"other"}' })).toBeNull();
    expect(parseAssistantRequestJob({ ...valid, arguments: "{" })).toBeNull();
    expect(parseAssistantRequestJob({ ...valid, operation: "create_agent" })).toBeNull();
  });
});
