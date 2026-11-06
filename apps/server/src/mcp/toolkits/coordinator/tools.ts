import {
  CoordinatorInboxToolInput,
  CoordinatorInboxToolResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const InboxTool = Tool.make("t3_inbox", {
  description:
    "The user's inbox from a coordinator: threads across linked environments waiting on a question or approval, failed, or finished and unread, plus notes a coordinator posted. post: tell the user something that needs them, such as a thread that ended asking a question. resolve: remove a note once handled.",
  parameters: CoordinatorInboxToolInput,
  success: CoordinatorInboxToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Coordinator inbox")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const CoordinatorToolkit = Toolkit.make(InboxTool);
