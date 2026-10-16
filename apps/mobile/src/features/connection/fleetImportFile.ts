import {
  decodeFleetImport,
  FLEET_IMPORT_MAX_BYTES,
} from "@t3tools/client-runtime/connection/fleet-import";
import type { ServerFleetEnvironment } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";

/**
 * Lets the user pick a fleet file and decodes it. Reads stop one byte past the
 * size limit, so an oversized pick is never loaded whole. Resolves null when
 * the user cancels.
 */
export async function pickFleetImportFile(): Promise<Result.Result<
  ReadonlyArray<ServerFleetEnvironment>,
  string
> | null> {
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
  return Result.mapError(decodeFleetImport(bytes), (error) => error.message);
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
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      reader.close();
    }
  } finally {
    file.delete();
  }
}
