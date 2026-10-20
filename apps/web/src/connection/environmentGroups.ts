import {
  EnvironmentGroupPreferences,
  EnvironmentGroupsError,
} from "@t3tools/client-runtime/state/environment-groups";
import { EnvironmentGroups } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ensureLocalApi } from "../localApi";

const decodeGroups = Schema.decodeUnknownSync(EnvironmentGroups);
const readGroups = async () =>
  decodeGroups((await ensureLocalApi().persistence.getClientSettings())?.environmentGroups ?? {});
const failure = (cause: unknown) =>
  new EnvironmentGroupsError({
    message: cause instanceof Error ? cause.message : "Could not load environment groups.",
  });

export const layerEnvironmentGroups = Layer.succeed(EnvironmentGroupPreferences, {
  load: Effect.tryPromise({ try: readGroups, catch: failure }),
  save: (groups) =>
    Effect.tryPromise({
      try: async () => {
        const { updateClientSettings } = await import("../hooks/useSettings");
        await updateClientSettings({ environmentGroups: groups });
        return readGroups();
      },
      catch: failure,
    }),
});
