import { CommandId, OrchestrationV2ThreadLaunchError, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { wasBootstrapThreadDeleted } from "./orchestration.ts";
describe("wasBootstrapThreadDeleted", () => {
  it("accepts a bootstrap launch whose provisional thread was deleted", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationV2ThreadLaunchError({
          commandId: CommandId.make("bootstrap-thread"),
          projectId: ProjectId.make("project-1"),
          message: "Failed to launch thread",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationV2ThreadLaunchError({
          commandId: CommandId.make("bootstrap-thread"),
          projectId: ProjectId.make("project-1"),
          message: "Failed to launch thread",
        }),
      ),
    ).toBe(false);
  });
});
