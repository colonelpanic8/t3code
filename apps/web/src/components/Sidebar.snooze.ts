/**
 * Snooze preset resolution for the sidebar snooze menu. Pure functions so
 * the preset math (evening/tomorrow/next-week boundaries) is unit-testable
 * without a DOM.
 *
 * Presets deliberately skew short: agent-thread rhythms are hours (a CI
 * run, a teammate review, the next work session), not days.
 */
import { parseTimestampDate } from "../timestampFormat";

type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const CUSTOM_TIME_STEP_MINUTES = 15;

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Value for a native datetime-local input. Native date inputs intentionally
 * have no timezone component; the value represents the user's wall clock.
 */
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

/**
 * Start custom snoozes one hour out, rounded up to a friendly quarter-hour.
 */
export function defaultCustomSnoozeDateTime(now: Date): string {
  const next = new Date(now.getTime() + HOUR_MS);
  next.setSeconds(0, 0);
  next.setMinutes(
    Math.ceil(next.getMinutes() / CUSTOM_TIME_STEP_MINUTES) * CUSTOM_TIME_STEP_MINUTES,
  );
  return formatSnoozeDateTimeLocal(next);
}

/**
 * Interpret a datetime-local value in the browser's local timezone and
 * return the ISO command payload. Invalid and non-future values are rejected.
 */
export function parseCustomSnoozeDateTime(value: string, now: Date): string | null {
  if (value.trim() === "") return null;
  const wakeAt = new Date(value);
  if (Number.isNaN(wakeAt.getTime()) || wakeAt.getTime() <= now.getTime()) return null;
  return wakeAt.toISOString();
}

/**
 * Presets for "snooze until", computed against local time. "This evening"
 * only appears while it is still meaningfully before evening; after that
 * the list starts at "Tomorrow".
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];

  const evening = atHour(now, EVENING_HOUR);
  // Suppress the evening preset once it is within an hour (or past): it
  // would duplicate "In 1 hour" or point at the past.
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  // Next Monday 9:00 (a week out when today is Monday).
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes
 * round up so a snooze never reads "0m" while still hidden.
 */
export function snoozeWakeLabel(snoozedUntil: string, now: Date): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "now";
  const remainingMs = wake.getTime() - now.getTime();
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(snoozedUntil: string, now: Date): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
