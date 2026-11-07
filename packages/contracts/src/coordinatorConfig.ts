import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// Separate module avoids an import cycle between settings and coordinator contracts.
export const CoordinatorId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/),
)
  .annotate({ description: "Lowercase letters, digits and dashes, such as chief-of-staff." })
  .pipe(Schema.brand("CoordinatorId"));
export type CoordinatorId = typeof CoordinatorId.Type;

const MIN_COORDINATOR_WAKE_MINUTES = 5;

export const CoordinatorConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** A folder on this environment, usually a repository. Absent: T3 makes one. */
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
  modelSelection: Schema.optionalKey(ModelSelection),
  /** Sent at the start of every coordinator session, after T3's own brief. */
  instructions: Schema.optionalKey(TrimmedString),
  /** Start a fresh session with the current inbox this often. Absent: only when asked. */
  wakeEveryMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_COORDINATOR_WAKE_MINUTES)),
  ),
});
export type CoordinatorConfig = typeof CoordinatorConfig.Type;
