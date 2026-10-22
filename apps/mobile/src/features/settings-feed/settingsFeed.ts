import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { fetch } from "expo/fetch";

import { readStream } from "../connection/fleetEnrollmentFile";
import { decryptFleetEnrollmentFile, isAgeEncryptedFile } from "../connection/fleetEnrollmentKey";
import {
  type ManagedPreferences,
  type Preferences,
  type SettingsFeedState,
  sanitizeManagedPreferences,
} from "../../persistence/mobile-preferences";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 128 * 1024;

/** A settings feed is a plain https:// file, age-encrypted to the fleet key or plain JSON. */
export function parseSettingsFeedUrl(value: string): Result.Result<string, string> {
  const invalid = Result.fail("Enter a plain https:// address.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return invalid;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return invalid;
  return Result.succeed(url.href);
}

/** `{ "version": 1, "preferences": { ... } }`; keys a feed cannot manage are ignored. */
export function decodeSettingsFeed(text: string): Result.Result<ManagedPreferences, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Result.fail("The settings feed is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    return Result.fail("The settings feed has no version.");
  }
  if (parsed.version !== 1)
    return Result.fail(`Unsupported settings feed version ${String(parsed.version)}.`);
  if (
    !("preferences" in parsed) ||
    typeof parsed.preferences !== "object" ||
    parsed.preferences === null ||
    Array.isArray(parsed.preferences)
  ) {
    return Result.fail("The settings feed has no preferences.");
  }
  return Result.succeed(sanitizeManagedPreferences(parsed.preferences as Preferences));
}

export async function fetchSettingsFeed(
  url: string,
): Promise<Result.Result<ManagedPreferences, string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return Result.fail(`Could not download the settings feed (HTTP ${response.status}).`);
    }
    bytes = await readStream(response.body, MAX_FEED_BYTES + 1);
  } catch {
    return Result.fail(
      controller.signal.aborted
        ? "Downloading the settings feed timed out."
        : "Could not download the settings feed.",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (bytes.byteLength > MAX_FEED_BYTES) return Result.fail("The settings feed is too large.");
  if (isAgeEncryptedFile(bytes)) {
    const decrypted = await Effect.runPromise(Effect.result(decryptFleetEnrollmentFile(bytes)));
    if (Result.isFailure(decrypted)) return Result.fail(decrypted.failure.message);
    bytes = decrypted.success;
  }
  return decodeSettingsFeed(new TextDecoder().decode(bytes));
}

/** A failed refresh keeps the last good values so the phone stays configured offline. */
export function nextSettingsFeedState(
  previous: SettingsFeedState,
  result: Result.Result<ManagedPreferences, string>,
  now: number,
): SettingsFeedState {
  if (Result.isSuccess(result)) {
    return { url: previous.url, managed: result.success, fetchedAt: now };
  }
  return {
    url: previous.url,
    ...(previous.managed === undefined ? {} : { managed: previous.managed }),
    ...(previous.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
    error: result.failure,
  };
}
