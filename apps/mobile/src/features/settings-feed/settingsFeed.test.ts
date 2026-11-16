import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0 }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({}));

import { decodeSettingsFeed, nextSettingsFeedState, parseSettingsFeedUrl } from "./settingsFeed";

describe("settings feed", () => {
  it("keeps only the preferences a feed may manage", () => {
    const decoded = decodeSettingsFeed(
      JSON.stringify({
        version: 1,
        preferences: {
          followUpBehavior: "steer",
          themeMode: "dark",
          collapsedProjectGroups: ["a"],
          composerEnterBehavior: "sideways",
        },
      }),
    );
    expect(decoded).toEqual(Result.succeed({ followUpBehavior: "steer", themeMode: "dark" }));
  });

  it("rejects files that are not a version 1 feed", () => {
    expect(Result.isFailure(decodeSettingsFeed("not json"))).toBe(true);
    expect(
      Result.isFailure(decodeSettingsFeed(JSON.stringify({ version: 2, preferences: {} }))),
    ).toBe(true);
    expect(Result.isFailure(decodeSettingsFeed(JSON.stringify({ version: 1 })))).toBe(true);
  });

  it("keeps the last good values when a refresh fails", () => {
    const previous = {
      url: "https://example.com/settings.age",
      managed: { followUpBehavior: "steer" as const },
      fetchedAt: 1,
    };
    expect(nextSettingsFeedState(previous, Result.fail("offline"), 2)).toEqual({
      ...previous,
      error: "offline",
    });
    expect(nextSettingsFeedState(previous, Result.succeed({ themeMode: "dark" }), 3)).toEqual({
      url: previous.url,
      managed: { themeMode: "dark" },
      fetchedAt: 3,
    });
  });

  it("accepts only plain https addresses", () => {
    expect(Result.isSuccess(parseSettingsFeedUrl(" https://example.com/s.age "))).toBe(true);
    expect(Result.isFailure(parseSettingsFeedUrl("http://example.com/s.age"))).toBe(true);
    expect(Result.isFailure(parseSettingsFeedUrl("https://user:pw@example.com/s.age"))).toBe(true);
  });
});
