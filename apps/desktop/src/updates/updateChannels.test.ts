import { describe, expect, it } from "vite-plus/test";
import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
describe("updateChannels", () => {
  it("ignores build metadata", () => {
    const version = "0.1.1-nightly.20261019.3348+17.g1451e7cb.assembly.e7f79b5b";
    expect(isNightlyDesktopVersion(version)).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel(version)).toBe("nightly");
    expect(isNightlyDesktopVersion("0.1.1-nightly.20261019.3348+")).toBe(false);
  });
});
