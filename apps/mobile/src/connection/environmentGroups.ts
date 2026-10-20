import {
  EnvironmentGroupPreferences,
  EnvironmentGroupsError,
} from "@t3tools/client-runtime/state/environment-groups";
import type { EnvironmentGroups } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Runtime from "../lib/runtime";
import { MobilePreferencesStore } from "../persistence/mobile-preferences";

export const layerEnvironmentGroups = Layer.effect(
  EnvironmentGroupPreferences,
  Effect.gen(function* () {
    const store = yield* MobilePreferencesStore;
    return {
      load: store.load.pipe(
        Effect.map((preferences) => preferences.environmentGroups ?? {}),
        Effect.mapError((error) => new EnvironmentGroupsError({ message: error.message })),
      ),
      save: (groups: EnvironmentGroups) =>
        store.savePatch({ environmentGroups: groups }).pipe(
          Effect.map((preferences) => preferences.environmentGroups ?? {}),
          Effect.mapError((error) => new EnvironmentGroupsError({ message: error.message })),
        ),
    };
  }),
).pipe(Layer.provide(Runtime.layer));
