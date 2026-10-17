import {
  decodeFleetImport,
  FLEET_IMPORT_MAX_BYTES,
} from "@t3tools/client-runtime/connection/fleet-import";
import type { ServerFleetEnvironment } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { fetch } from "expo/fetch";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { isAgeEncryptedFile } from "./fleetEnrollmentKey";
import type { FleetEnrollmentUrl } from "./fleetEnrollmentLink";

const DOWNLOAD_TIMEOUT_MS = 15_000;

export type FleetFile =
  | { readonly kind: "inventory"; readonly environments: ReadonlyArray<ServerFleetEnvironment> }
  /** An age-encrypted enrollment, still to be decrypted and confirmed. */
  | { readonly kind: "enrollment"; readonly bytes: Uint8Array };

/**
 * Lets the user pick a fleet file, either a plain inventory or an encrypted
 * enrollment. Reads stop one byte past the size limit, so an oversized pick is
 * never loaded whole. Resolves null when the user cancels.
 */
export async function pickFleetImportFile(): Promise<Result.Result<FleetFile, string> | null> {
  const endHandoff = beginForegroundHandoff();
  let uri: string;
  try {
    const { getDocumentAsync } = await import("expo-document-picker");
    const picked = await getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return null;
    const asset = picked.assets[0];
    if (asset === undefined) return null;
    uri = asset.uri;
  } catch {
    return Result.fail("Could not open the file picker.");
  } finally {
    endHandoff();
  }

  let bytes: Uint8Array;
  try {
    bytes = await readAndDeleteCacheCopy(uri, FLEET_IMPORT_MAX_BYTES + 1);
  } catch {
    return Result.fail("Could not read that file.");
  }
  return classifyFleetFile(bytes);
}

/**
 * Downloads a fleet file from an enrollment link. Content-Length is not
 * trusted: reading stops one byte past the size limit.
 */
export async function downloadFleetFile(
  url: FleetEnrollmentUrl,
): Promise<Result.Result<FleetFile, string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      // An unread error body holds the connection open until GC otherwise.
      void response.body?.cancel().catch(() => undefined);
      return Result.fail(`Could not download the fleet file (HTTP ${response.status}).`);
    }
    return classifyFleetFile(await readStream(response.body, FLEET_IMPORT_MAX_BYTES + 1));
  } catch {
    return Result.fail(
      controller.signal.aborted
        ? "Downloading the fleet file timed out."
        : "Could not download the fleet file.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sorts a fleet file into an inventory or an encrypted enrollment. Sources
 * read at most one byte past `FLEET_IMPORT_MAX_BYTES`, which this rejects.
 */
export function classifyFleetFile(bytes: Uint8Array): Result.Result<FleetFile, string> {
  if (isAgeEncryptedFile(bytes)) {
    return bytes.byteLength > FLEET_IMPORT_MAX_BYTES
      ? Result.fail("That fleet enrollment file is too large.")
      : Result.succeed({ kind: "enrollment", bytes });
  }
  return Result.mapBoth(decodeFleetImport(bytes), {
    onSuccess: (environments) => ({ kind: "inventory", environments }),
    onFailure: (error) => error.message,
  });
}

async function readAndDeleteCacheCopy(uri: string, maxBytes: number): Promise<Uint8Array> {
  const { File, FileMode } = await import("expo-file-system");
  const file = new File(uri);
  try {
    const reader = file.open(FileMode.ReadOnly);
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < maxBytes) {
        const chunk = await reader.readBytes(maxBytes - total);
        if (chunk.byteLength === 0) break;
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      return joinChunks(chunks, total);
    } finally {
      reader.close();
    }
  } finally {
    file.delete();
  }
}

async function readStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, maxBytes - total);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return joinChunks(chunks, total);
}

function joinChunks(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
