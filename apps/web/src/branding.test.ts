import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveServerBackedAppStageLabel } from "./branding.logic";
const originalWindow = globalThis.window;
afterEach(() => {
  vi.resetModules();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }
  globalThis.window = originalWindow;
});
describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions with build metadata", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.1.1-nightly.20261019.3348+17.g1451e7cb",
        fallbackStageLabel: "Beta",
      }),
    ).toBe("Nightly");
  });
});
