import { describe, expect, it } from "vite-plus/test";
import { partitionThreadFindRanges } from "./threadFindHighlights";

const groups = [
  { rowId: "m1", ranges: ["m1-a", "m1-b"] },
  { rowId: "m2", ranges: ["m2-a", "m2-b", "m2-c"] },
];

describe("partitionThreadFindRanges", () => {
  it("marks exactly one occurrence active, not the whole row", () => {
    expect(partitionThreadFindRanges(groups, "m2", 1)).toEqual({
      active: "m2-b",
      inactive: ["m1-a", "m1-b", "m2-a", "m2-c"],
    });
  });

  it("clamps an occurrence the mounted DOM cannot offer", () => {
    expect(partitionThreadFindRanges(groups, "m1", 9)).toEqual({
      active: "m1-b",
      inactive: ["m1-a", "m2-a", "m2-b", "m2-c"],
    });
  });

  it("leaves every range inactive when the active row is not mounted", () => {
    expect(partitionThreadFindRanges(groups, "m9", 0)).toEqual({
      active: null,
      inactive: ["m1-a", "m1-b", "m2-a", "m2-b", "m2-c"],
    });
    expect(partitionThreadFindRanges(groups, null, 0).active).toBeNull();
  });

  it("handles an empty collection", () => {
    expect(partitionThreadFindRanges([], "m1", 0)).toEqual({ active: null, inactive: [] });
  });
});
