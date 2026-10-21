import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentGroupsDocument } from "./environmentGroups.ts";
import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";
const groups = {
  family: {
    label: "Family",
    environmentIds: ["parents-desktop", "sibling-laptop"],
    defaultVisible: false,
  },
};
const decode = Schema.decodeUnknownSync(EnvironmentGroupsDocument);
const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
describe("environment group declarations", () => {
  it("preserves membership and hidden defaults in portable files and client settings", () => {
    expect(
      decode({
        version: 1,
        groups,
      }).groups,
    ).toEqual(groups);
    expect(
      decodeSettings({
        environmentGroups: groups,
      }).environmentGroups,
    ).toEqual(groups);
    expect(
      decodePatch({
        environmentGroups: groups,
      }),
    ).toEqual({
      environmentGroups: groups,
    });
    expect(decodeSettings({}).environmentGroups).toEqual({});
  });
  it("rejects ambiguous membership, including repetitions within one group", () => {
    expect(() =>
      decode({
        version: 1,
        groups: {
          ...groups,
          work: {
            ...groups.family,
            label: "Work",
          },
        },
      }),
    ).toThrow("only one group");
    expect(() =>
      decode({
        version: 1,
        groups: {
          family: {
            ...groups.family,
            environmentIds: ["same", "same"],
          },
        },
      }),
    ).toThrow("only one group");
  });
  it("requires explicit defaults and a supported document version", () => {
    expect(() =>
      decode({
        version: 2,
        groups,
      }),
    ).toThrow();
    expect(() =>
      decode({
        version: 1,
        groups: {
          family: {
            label: "Family",
            environmentIds: [],
          },
        },
      }),
    ).toThrow();
  });
  it("rejects credentials and other fields when importing group documents", () => {
    expect(() =>
      decode(
        {
          version: 1,
          groups,
          token: "secret",
        },
        {
          onExcessProperty: "error",
        },
      ),
    ).toThrow();
  });
});
