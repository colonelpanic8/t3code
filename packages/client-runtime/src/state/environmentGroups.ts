import {
  EnvironmentGroupsDocument,
  type EnvironmentGroups,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { createRuntimeCommand } from "./runtime.ts";

const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(EnvironmentGroupsDocument));

export class EnvironmentGroupsError extends Schema.TaggedError<EnvironmentGroupsError>()(
  "EnvironmentGroupsError",
  { message: Schema.String },
) {}

export class EnvironmentGroupPreferences extends Context.Reference<{
  readonly load: Effect.Effect<EnvironmentGroups, EnvironmentGroupsError>;
  readonly save: (
    groups: EnvironmentGroups,
  ) => Effect.Effect<EnvironmentGroups, EnvironmentGroupsError>;
}>("@t3tools/client-runtime/state/EnvironmentGroupPreferences", {
  defaultValue: () => ({
    load: Effect.succeed({}),
    save: () =>
      Effect.fail(new EnvironmentGroupsError({ message: "Group configuration is not supported." })),
  }),
}) {}

export function hiddenGroupEnvironmentIds(
  groups: EnvironmentGroups,
  overrides: ReadonlyMap<string, boolean>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    Object.entries(groups).flatMap(([id, group]) =>
      (overrides.get(id) ?? group.defaultVisible) ? [] : group.environmentIds,
    ),
  );
}

export function createEnvironmentGroupAtoms<R, E>(runtime: Atom.AtomRuntime<R, E>) {
  const definitionsAtom = runtime
    .atom(EnvironmentGroupPreferences.pipe(Effect.flatMap((preferences) => preferences.load)))
    .pipe(Atom.keepAlive);
  const importedAtom = Atom.make<Option.Option<EnvironmentGroups>>(Option.none()).pipe(
    Atom.keepAlive,
  );
  const overridesAtom = Atom.make<ReadonlyMap<string, boolean>>(new Map()).pipe(Atom.keepAlive);
  const stateAtom = Atom.make((get) => {
    const definitions = get(definitionsAtom);
    const imported = get(importedAtom);
    const groups = Option.getOrElse(imported, () =>
      Option.getOrElse(AsyncResult.value(definitions), () => ({})),
    );
    const overrides = get(overridesAtom);
    return {
      isReady: Option.isSome(imported) || AsyncResult.isSuccess(definitions),
      failed: Option.isNone(imported) && AsyncResult.isFailure(definitions),
      groups,
      overrides,
      hiddenEnvironmentIds: hiddenGroupEnvironmentIds(groups, overrides),
    };
  });
  const setVisible = createRuntimeCommand(runtime, {
    label: "environment-groups:set-visible",
    execute: (input: { readonly groupId: string; readonly visible: boolean }, registry) =>
      Effect.sync(() => {
        if (!Object.hasOwn(registry.get(stateAtom).groups, input.groupId)) return;
        registry.set(
          overridesAtom,
          new Map(registry.get(overridesAtom)).set(input.groupId, input.visible),
        );
      }),
  });
  const resetVisibility = createRuntimeCommand(runtime, {
    label: "environment-groups:reset-visibility",
    execute: (_: void, registry) => Effect.sync(() => registry.set(overridesAtom, new Map())),
  });
  const importDocument = createRuntimeCommand(runtime, {
    label: "environment-groups:import",
    concurrency: { mode: "serial", key: () => "environment-groups" },
    execute: Effect.fn("EnvironmentGroups.importDocument")(function* (
      json: string,
      registry: AtomRegistry.AtomRegistry,
    ) {
      const document = yield* decodeDocument(json, { onExcessProperty: "error" }).pipe(
        Effect.mapError((error) => new EnvironmentGroupsError({ message: error.message })),
      );
      const preferences = yield* EnvironmentGroupPreferences;
      const groups = yield* preferences.save(document.groups);
      registry.set(importedAtom, Option.some(groups));
      registry.set(
        overridesAtom,
        new Map([...registry.get(overridesAtom)].filter(([id]) => Object.hasOwn(groups, id))),
      );
    }),
  });
  return { definitionsAtom, stateAtom, setVisible, resetVisibility, importDocument };
}
