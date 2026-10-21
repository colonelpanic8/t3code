import { EnvironmentId, type EnvironmentGroups } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createEnvironmentGroupAtoms,
  EnvironmentGroupPreferences,
  EnvironmentGroupsError,
  hiddenGroupEnvironmentIds,
} from "./environmentGroups.ts";
const familyId = EnvironmentId.make("family-machine");
const personalId = EnvironmentId.make("personal-machine");
const groups: EnvironmentGroups = {
  family: {
    label: "Family",
    environmentIds: [familyId],
    defaultVisible: false,
  },
  personal: {
    label: "Personal",
    environmentIds: [personalId],
    defaultVisible: true,
  },
};
const registries: Array<AtomRegistry.AtomRegistry> = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});
function client(options?: { readonly failSave?: boolean }) {
  let stored = groups;
  const saved: Array<EnvironmentGroups> = [];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentGroupPreferences, {
      load: Effect.sync(() => stored),
      save: (next) =>
        options?.failSave
          ? Effect.fail(
              new EnvironmentGroupsError({
                message: "Disk is read-only",
              }),
            )
          : Effect.sync(() => {
              stored = next;
              saved.push(next);
              return next;
            }),
    }),
  );
  const atoms = createEnvironmentGroupAtoms(runtime);
  const registry = AtomRegistry.make();
  registries.push(registry);
  return {
    atoms,
    registry,
    saved,
  };
}
describe("session environment group visibility", () => {
  it("applies defaults, leaves ungrouped machines alone, and allows all groups to be hidden", () => {
    expect(hiddenGroupEnvironmentIds(groups, new Map())).toEqual(new Set([familyId]));
    expect(hiddenGroupEnvironmentIds(groups, new Map([["personal", false]]))).toEqual(
      new Set([familyId, personalId]),
    );
    expect(hiddenGroupEnvironmentIds(groups, new Map([["family", true]]))).toEqual(new Set());
  });
  it("keeps overrides across navigation without saving them, and restores defaults next session", async () => {
    const { atoms, registry, saved } = client();
    await expect.poll(() => registry.get(atoms.stateAtom).isReady).toBe(true);
    expect(registry.get(atoms.stateAtom).hiddenEnvironmentIds.has(familyId)).toBe(true);
    await atoms.setVisible.run(registry, {
      groupId: "family",
      visible: true,
    });
    const unmount = registry.mount(atoms.stateAtom);
    unmount();
    expect(registry.get(atoms.stateAtom).hiddenEnvironmentIds.has(familyId)).toBe(false);
    expect(saved).toEqual([]);
    const nextSession = AtomRegistry.make();
    registries.push(nextSession);
    await expect.poll(() => nextSession.get(atoms.stateAtom).isReady).toBe(true);
    expect(nextSession.get(atoms.stateAtom).hiddenEnvironmentIds.has(familyId)).toBe(true);
    await atoms.resetVisibility.run(registry, undefined);
    expect(registry.get(atoms.stateAtom).hiddenEnvironmentIds.has(familyId)).toBe(true);
    expect(saved).toEqual([]);
  });
  it("imports definitions while retaining only overrides for groups that still exist", async () => {
    const { atoms, registry, saved } = client();
    await expect.poll(() => registry.get(atoms.stateAtom).isReady).toBe(true);
    await atoms.setVisible.run(registry, {
      groupId: "family",
      visible: true,
    });
    await atoms.setVisible.run(registry, {
      groupId: "personal",
      visible: false,
    });
    const next = {
      family: groups.family,
    };
    const result = await atoms.importDocument.run(
      registry,
      JSON.stringify({
        version: 1,
        groups: next,
      }),
    );
    expect(result._tag).toBe("Success");
    expect(saved).toEqual([next]);
    expect(registry.get(atoms.stateAtom).overrides).toEqual(new Map([["family", true]]));
    expect(registry.get(atoms.stateAtom).hiddenEnvironmentIds).toEqual(new Set());
  });
  it("retains the current declaration and overrides when an import cannot be saved", async () => {
    const { atoms, registry } = client({
      failSave: true,
    });
    await expect.poll(() => registry.get(atoms.stateAtom).isReady).toBe(true);
    await atoms.setVisible.run(registry, {
      groupId: "family",
      visible: true,
    });
    const result = await atoms.importDocument.run(
      registry,
      JSON.stringify({
        version: 1,
        groups: {},
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(registry.get(atoms.stateAtom).groups).toEqual(groups);
    expect(registry.get(atoms.stateAtom).overrides).toEqual(new Map([["family", true]]));
  });
  it("rejects invalid declarations before saving", async () => {
    const { atoms, registry, saved } = client();
    const result = await atoms.importDocument.run(
      registry,
      JSON.stringify({
        version: 1,
        groups: {
          ...groups,
          duplicate: groups.family,
        },
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(saved).toEqual([]);
  });
});
