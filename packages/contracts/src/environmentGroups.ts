import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EnvironmentGroups = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Struct({
    label: TrimmedNonEmptyString,
    environmentIds: Schema.Array(EnvironmentId),
    defaultVisible: Schema.Boolean,
  }),
).check(
  Schema.makeFilter((groups) => {
    const members = Object.values(groups).flatMap((group) => group.environmentIds);
    return (
      new Set(members).size === members.length || "Each environment can belong to only one group."
    );
  }),
);
export type EnvironmentGroups = typeof EnvironmentGroups.Type;

export const EnvironmentGroupsDocument = Schema.Struct({
  version: Schema.Literal(1),
  groups: EnvironmentGroups,
});
