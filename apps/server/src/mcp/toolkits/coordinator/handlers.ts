import { type CoordinatorError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CoordinatorService from "../../../coordinator/CoordinatorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CoordinatorToolkit } from "./tools.ts";

const invalid = (error: CoordinatorError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const build = Effect.gen(function* () {
  const coordinators = yield* CoordinatorService.CoordinatorService;

  const coordinatorFor = (
    coordinatorId: Parameters<typeof coordinators.resolveId>[0]["coordinatorId"],
  ) =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap((scope) =>
        coordinators.resolveId({ coordinatorId, threadId: scope.thread?.threadId }),
      ),
    );

  return {
    t3_inbox: McpToolAccess.either(
      (input) => input.action === "list" || input.action === "local",
      McpToolAccess.reads((input) =>
        input.action === "local"
          ? coordinators.localAttention.pipe(Effect.map((items) => ({ items })))
          : coordinatorFor(input.coordinatorId).pipe(
              Effect.flatMap(coordinators.inbox),
              Effect.map((inbox) => ({ items: inbox.items, sources: inbox.sources })),
              Effect.mapError(invalid),
            ),
      ),
      McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            const id = yield* coordinatorFor(input.coordinatorId);
            if (input.action === "resolve") {
              if (input.itemId === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "resolve needs itemId.",
                });
              }
              yield* coordinators.resolve(id, input.itemId);
              return { items: (yield* coordinators.inbox(id)).items };
            }
            if (input.title === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "post needs title.",
              });
            }
            const posted = yield* coordinators.post(id, {
              title: input.title,
              detail: input.detail ?? null,
              thread: input.thread ?? null,
            });
            return { items: [], posted };
          }).pipe(Effect.catchTags({ CoordinatorError: (error) => Effect.fail(invalid(error)) })),
        // A worker on another machine may leave the user a note here.
        { linkedCallers: "allowed" },
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof CoordinatorToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(CoordinatorToolkit, build);
