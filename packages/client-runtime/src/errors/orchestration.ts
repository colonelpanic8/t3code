import {
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadLaunchError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isBootstrapThreadError = Schema.is(
  Schema.Union([OrchestrationDispatchCommandError, OrchestrationV2ThreadLaunchError]),
);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return isBootstrapThreadError(error) && error.bootstrapThreadDisposition === "deleted";
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}
