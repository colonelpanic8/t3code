import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const CUSTOM_TIME_STEP_MINUTES = 15;
const CUSTOM_TIME_STEP_MS = CUSTOM_TIME_STEP_MINUTES * 60_000;

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function formatSnoozeDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

export function defaultCustomSnoozeDateTime(now: Date): string {
  const minimumWakeTime = now.getTime() + HOUR_MS;
  const next = new Date(minimumWakeTime);
  next.setSeconds(0, 0);
  if (next.getTime() < minimumWakeTime) next.setTime(next.getTime() + 60_000);
  next.setMinutes(
    Math.ceil(next.getMinutes() / CUSTOM_TIME_STEP_MINUTES) * CUSTOM_TIME_STEP_MINUTES,
  );

  for (let attempts = 0; attempts < 24 * (60 / CUSTOM_TIME_STEP_MINUTES); attempts += 1) {
    const value = formatSnoozeDateTimeLocal(next);
    const parsed = parseCustomSnoozeDateTime(value, now);
    if (parsed !== null && new Date(parsed).getTime() >= minimumWakeTime) return value;
    next.setTime(next.getTime() + CUSTOM_TIME_STEP_MS);
  }
  return "";
}

export function parseCustomSnoozeDateTime(value: string, now: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const wakeAt = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(wakeAt.getTime()) || wakeAt.getTime() <= now.getTime()) return null;
  if (
    wakeAt.getFullYear() !== year ||
    wakeAt.getMonth() !== month - 1 ||
    wakeAt.getDate() !== day ||
    wakeAt.getHours() !== hour ||
    wakeAt.getMinutes() !== minute
  ) {
    return null;
  }
  return wakeAt.toISOString();
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      whenLabel:
        preset.id === "next-week"
          ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
          : time,
    };
  });
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
