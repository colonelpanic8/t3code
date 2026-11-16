import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { parseModelOptions } from "./assistant-models";
import { Outcome } from "./assistant-outcome";
import {
  planThreadAction,
  resolveQuestionAnswers,
  type ThreadActionEnvironment,
} from "./assistant-thread-actions";

const KEY = "c".repeat(64);
const NOW = new Date("2026-10-19T12:00:00.000Z");
const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function question(overrides: Partial<ThreadUserInputQuestion> = {}): ThreadUserInputQuestion {
  return {
    id: "next",
    header: "Next step",
    question: "What should I do?",
    options: [
      { label: "Ship it", description: "Merge now", value: "ship" },
      { label: "Wait", description: "Hold off" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

function outcomeOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof Outcome) return error.update;
    throw error;
  }
  throw new Error("expected an outcome");
}

async function outcomeOfAsync(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Outcome) return error.update;
    throw error;
  }
  throw new Error("expected an outcome");
}

describe("resolveQuestionAnswers", () => {
  it("maps spoken labels and option numbers onto option values", () => {
    expect(resolveQuestionAnswers([question()], { answer: "ship it" })).toEqual({ next: "ship" });
    expect(resolveQuestionAnswers([question()], { answer: "option 2" })).toEqual({ next: "Wait" });
    expect(
      resolveQuestionAnswers([question({ multiSelect: true })], { answer: "Wait, Ship it" }),
    ).toEqual({ next: ["Wait", "ship"] });
  });

  it("keeps free text only where the question allows it", () => {
    expect(resolveQuestionAnswers([question()], { answer: "Ask Bob first" })).toEqual({
      next: "Ask Bob first",
    });
    const closed = outcomeOf(() =>
      resolveQuestionAnswers([question({ allowCustomAnswer: false })], { answer: "Ask Bob" }),
    );
    expect(closed.error?.code).toBe("invalid_answer");
    expect(closed.error?.message).toContain("Ship it | Wait");
  });

  it("needs answersJson for several questions and accepts headers as keys", () => {
    const questions = [question(), question({ id: "who", header: "Reviewer", options: [] })];
    expect(outcomeOf(() => resolveQuestionAnswers(questions, { answer: "Wait" })).error?.code).toBe(
      "answers_required",
    );
    expect(
      resolveQuestionAnswers(questions, { answersJson: '{"next":"Wait","reviewer":"Ivan"}' }),
    ).toEqual({ next: "Wait", who: "Ivan" });
    expect(
      outcomeOf(() => resolveQuestionAnswers(questions, { answersJson: '{"next":"Wait"}' })).error
        ?.code,
    ).toBe("answers_required");
  });
});

describe("parseModelOptions", () => {
  const model = {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
        { id: "fastMode", label: "Fast mode", type: "boolean" },
      ],
    },
  } as ServerProviderModel;

  it("matches option ids or labels loosely", () => {
    expect(parseModelOptions("reasoning effort=Low, fast_mode=on", model)).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("lists what the model takes when an option is unknown", () => {
    const update = outcomeOf(() => parseModelOptions("effort=max", model));
    expect(update.error?.message).toContain("reasoningEffort=low|high (default high)");
  });
});

describe("planThreadAction", () => {
  function environment(
    overrides: Partial<Parameters<typeof makeThreadShellFixture>[0]> = {},
    projection: Partial<OrchestrationV2ThreadProjection> | null = null,
  ): ThreadActionEnvironment {
    const thread = makeThreadShellFixture({
      environmentId,
      id: threadId,
      title: "Fix login",
      ...overrides,
    });
    return {
      environmentName: "ryzen-shine",
      thread: (id) => (id === threadId ? thread : null),
      providers: () => [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          status: "ready",
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
        } as never,
      ],
      threadProjection: async () =>
        projection === null
          ? null
          : ({
              runs: [],
              turnItems: [],
              runtimeRequests: [],
              messages: [],
              ...projection,
            } as OrchestrationV2ThreadProjection),
    };
  }
  const input = (env: ThreadActionEnvironment) => ({ key: KEY, environment: env, now: NOW });
  const target = { environmentId, threadId };

  it("finishes without sending when the thread is already as asked", async () => {
    const update = await outcomeOfAsync(() =>
      planThreadAction(
        "organize_thread",
        { ...target, action: "archive" },
        input(environment({ archivedAt: "2026-10-18T00:00:00.000Z" })),
      ),
    );
    expect(update).toEqual({
      state: "completed",
      summary: "“Fix login” is already archived on ryzen-shine.",
    });
  });

  it("fixes a relative snooze to an absolute time when planning", async () => {
    const plan = await planThreadAction(
      "organize_thread",
      { ...target, action: "snooze", snoozeMinutes: 90 },
      input(environment()),
    );
    expect(plan).toMatchObject({
      kind: "organize_thread",
      commandId: `eva:${KEY}`,
      snoozedUntil: "2026-10-19T13:30:00.000Z",
    });
  });

  it("answers only approvals that are still pending, with offered decisions", async () => {
    const createdAt = DateTime.makeUnsafe("2026-10-19T11:59:00.000Z");
    const pending = {
      runtimeRequests: [
        {
          id: "req-1",
          nodeId: "node-1",
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command_execution",
          status: "pending",
          responseCapability: { type: "live" },
          createdAt,
          resolvedAt: null,
        },
      ],
    } as unknown as Partial<OrchestrationV2ThreadProjection>;
    const plan = await planThreadAction(
      "respond_to_approval",
      { ...target, requestId: "req-1", decision: "accept_for_session" },
      input(environment({}, pending)),
    );
    expect(plan).toMatchObject({ decision: "acceptForSession", requestId: "req-1" });
    const stale = await outcomeOfAsync(() =>
      planThreadAction(
        "respond_to_approval",
        { ...target, requestId: "req-2", decision: "accept" },
        input(environment({}, pending)),
      ),
    );
    expect(stale.error?.code).toBe("request_not_pending");
  });

  it("does not stop a thread that is not running", async () => {
    const update = await outcomeOfAsync(() =>
      planThreadAction("interrupt_thread", target, input(environment({}, {}))),
    );
    expect(update.state).toBe("completed");
    expect(update.summary).toBe("“Fix login” is not running a turn on ryzen-shine.");
  });

  it("leaves a request pending when the environment does not return the thread", async () => {
    await expect(
      planThreadAction("interrupt_thread", target, input(environment({}, null))),
    ).rejects.not.toBeInstanceOf(Outcome);
  });
});
