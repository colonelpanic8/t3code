import { describe, expect, it } from "@effect/vitest";

import { SETTINGS_NAV_GROUPS } from "./SettingsSidebarNav";
import { isEnvironmentSettingsPath } from "./settingsEnvironmentRoutes";

describe("environment settings routes", () => {
  it.each([
    "/settings/environment",
    "/settings/keybindings",
    "/settings/providers",
    "/settings/source-control",
    "/settings/diagnostics",
  ])("shows the shared environment selector on %s", (pathname) => {
    expect(isEnvironmentSettingsPath(pathname)).toBe(true);
  });

  it.each(["/settings/general", "/settings/connections", "/settings/beta", "/settings/archived"])(
    "keeps client and aggregate pages environment-independent on %s",
    (pathname) => {
      expect(isEnvironmentSettingsPath(pathname)).toBe(false);
    },
  );

  it("matches the client and environment navigation groups", () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      for (const item of group.items) {
        expect(isEnvironmentSettingsPath(item.to)).toBe(group.label === "Environment");
      }
    }
  });
});
