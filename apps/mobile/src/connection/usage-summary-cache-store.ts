import { UsageQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MobileDatabase } from "../persistence/mobile-database";

export const layer = Layer.effect(
  UsageQueryStore,
  Effect.gen(function* () {
    const database = yield* MobileDatabase;
    return {
      load: (environmentId, key) =>
        database
          .loadCache(environmentId, "usage-summary", key)
          .pipe(Effect.catch(() => Effect.succeedNone)),
      save: (environmentId, key, payload) =>
        database
          .saveCache(environmentId, "usage-summary", key, 1, payload)
          .pipe(Effect.catch(() => Effect.logWarning("Could not save the usage summary cache."))),
      remove: (environmentId, key) =>
        database.removeCache(environmentId, "usage-summary", key).pipe(Effect.ignore),
    } satisfies NonNullable<typeof UsageQueryStore.Service>;
  }),
);
