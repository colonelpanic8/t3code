import { FLEET_IMPORT_MAX_BYTES } from "@t3tools/client-runtime/connection/fleet-import";
import * as Result from "effect/Result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("expo-secure-store", () => import("./fleetEnrollmentKey.secure-store-mock"));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pick }));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "read" },
  File: class {
    open = mocks.open;
    delete = mocks.remove;
  },
}));

import { parseFleetEnrollmentUrl } from "./fleetEnrollmentLink";
import { classifyFleetFile, downloadFleetFile, pickFleetImportFile } from "./fleetImportFile";

function ageFile(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength).fill(0x41);
  bytes.set(new TextEncoder().encode("age-encryption.org/v1\n"));
  return bytes;
}

describe("classifyFleetFile", () => {
  it("accepts an enrollment at the size limit and rejects one byte more", () => {
    const atLimit = ageFile(FLEET_IMPORT_MAX_BYTES);
    expect(classifyFleetFile(atLimit)).toEqual(
      Result.succeed({ kind: "enrollment", bytes: atLimit }),
    );
    expect(classifyFleetFile(ageFile(FLEET_IMPORT_MAX_BYTES + 1))).toEqual(
      Result.fail("That fleet enrollment file is too large."),
    );
  });

  it("reports a file that is neither an enrollment nor an inventory", () => {
    expect(classifyFleetFile(new TextEncoder().encode("<html></html>"))).toEqual(
      Result.fail("That file is not a T3 Code fleet file."),
    );
  });
});

describe("fleet file cache cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pick.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///cache/picked.json" }],
    });
    mocks.open.mockReturnValue({ readBytes: mocks.read, close: mocks.close });
    mocks.read.mockResolvedValue(new Uint8Array());
  });

  it("deletes a rejected file containing credentials after closing the reader", async () => {
    mocks.read.mockResolvedValueOnce(new TextEncoder().encode('{"token":"fixture-secret"}'));
    const result = await pickFleetImportFile();
    expect(result !== null && Result.isFailure(result)).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["open", "read", "close"] as const)(
    "deletes the copied file when %s fails",
    async (step) => {
      mocks[step].mockImplementationOnce(() => {
        throw new Error("fixture failure");
      });
      const result = await pickFleetImportFile();
      expect(result !== null && Result.isFailure(result)).toBe(true);
      expect(mocks.remove).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["binary", "age-encryption.org/v1\n-> X25519 fixture\n"],
    ["armored", "\n-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n"],
  ])("hands a %s age file to enrollment and deletes the copy", async (_format, contents) => {
    const bytes = new TextEncoder().encode(contents);
    mocks.read.mockResolvedValueOnce(bytes);
    expect(await pickFleetImportFile()).toEqual(Result.succeed({ kind: "enrollment", bytes }));
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("leaves files alone when the picker is canceled", async () => {
    mocks.pick.mockResolvedValueOnce({ canceled: true });
    expect(await pickFleetImportFile()).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("downloadFleetFile", () => {
  const url = Result.getOrThrow(parseFleetEnrollmentUrl("https://example.test/fleet.age"));

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a downloaded age file to enrollment", async () => {
    const bytes = new TextEncoder().encode("age-encryption.org/v1\n-> X25519 fixture\n");
    mocks.fetch.mockResolvedValueOnce(new Response(bytes));
    expect(await downloadFleetFile(url)).toEqual(Result.succeed({ kind: "enrollment", bytes }));
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe("https://example.test/fleet.age");
  });

  it("lists the machines of a downloaded inventory", async () => {
    const environment = {
      environmentId: "env-alpha",
      label: "Alpha",
      httpBaseUrl: "https://alpha.example.test",
      wsBaseUrl: "wss://alpha.example.test",
    };
    mocks.fetch.mockResolvedValueOnce(Response.json({ version: 1, environments: [environment] }));
    expect(await downloadFleetFile(url)).toEqual(
      Result.succeed({ kind: "inventory", environments: [environment] }),
    );
  });

  it("reports the status of a failed download", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    expect(await downloadFleetFile(url)).toEqual(
      Result.fail("Could not download the fleet file (HTTP 404)."),
    );
  });

  it("stops reading an endless body one byte past the limit despite its Content-Length", async () => {
    const chunk = ageFile(16 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(chunk),
    });
    mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { "Content-Length": "64" } }));
    expect(await downloadFleetFile(url)).toEqual(
      Result.fail("That fleet enrollment file is too large."),
    );
  });

  it("gives up on a download that never answers", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = downloadFleetFile(url);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual(Result.fail("Downloading the fleet file timed out."));
  });
});
