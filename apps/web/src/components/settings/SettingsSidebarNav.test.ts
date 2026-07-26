import { describe, expect, it } from "@effect/vitest";

import { SETTINGS_NAV_GROUPS } from "./SettingsSidebarNav";

describe("settings navigation ownership", () => {
  it("separates client-owned pages from environment-owned pages", () => {
    expect(
      SETTINGS_NAV_GROUPS.map((group) => ({
        label: group.label,
        environmentSelector: group.environmentSelector,
        routes: group.items.map((item) => item.to),
      })),
    ).toEqual([
      {
        label: "Client",
        environmentSelector: false,
        routes: [
          "/settings/general",
          "/settings/keybindings",
          "/settings/connections",
          "/settings/beta",
          "/settings/archived",
        ],
      },
      {
        label: "Environment",
        environmentSelector: true,
        routes: ["/settings/environment", "/settings/providers", "/settings/source-control"],
      },
    ]);
  });
});
