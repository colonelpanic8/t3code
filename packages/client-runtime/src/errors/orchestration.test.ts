import { CommandId, OrchestrationV2DispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { wasBootstrapThreadDeleted } from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make("bootstrap-thread"),
          commandType: "thread.start",
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make("bootstrap-thread"),
          commandType: "thread.start",
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});
