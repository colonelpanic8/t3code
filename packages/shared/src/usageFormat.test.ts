// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatHourShort,
  makeWindow,
  msUntilNextLocalDay,
  startOfLocalDay,
} from "./usageFormat.ts";

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EDT",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EST",
    );
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

describe("local day boundaries", () => {
  it("measures to the next local midnight, including days daylight saving shortens", () => {
    try {
      vi.stubEnv("TZ", "America/New_York");
      expect(msUntilNextLocalDay(new Date("2026-10-14T23:59:00-04:00"))).toBe(60_000);
      expect(msUntilNextLocalDay(new Date("2026-10-14T00:00:00-04:00"))).toBe(86_400_000);
      // New York springs forward on 2026-03-08, a 23-hour day.
      expect(msUntilNextLocalDay(new Date("2026-03-08T00:00:00-05:00"))).toBe(23 * 3_600_000);
      expect(startOfLocalDay(new Date("2026-10-14T03:30:00Z")).toISOString()).toBe(
        "2026-10-13T04:00:00.000Z",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("re-anchors a window to the new local day once midnight passes", () => {
    try {
      vi.stubEnv("TZ", "America/New_York");
      const lateEvening = new Date("2026-10-14T23:59:30-04:00");
      const afterMidnight = new Date(lateEvening.getTime() + msUntilNextLocalDay(lateEvening));
      expect(makeWindow(7, lateEvening)).toMatchObject({
        sinceDay: "2026-10-08",
        untilDay: "2026-10-14",
      });
      expect(makeWindow(7, afterMidnight)).toMatchObject({
        sinceDay: "2026-10-09",
        untilDay: "2026-10-15",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
