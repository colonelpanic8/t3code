import {
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadLaunchError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isBootstrapThreadError = Schema.is(
  Schema.Union([OrchestrationV2DispatchCommandError, OrchestrationV2ThreadLaunchError]),
);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return isBootstrapThreadError(error) && error.bootstrapThreadDisposition === "deleted";
}
