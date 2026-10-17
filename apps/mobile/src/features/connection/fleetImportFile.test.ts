import { FLEET_IMPORT_MAX_BYTES } from "@t3tools/client-runtime/connection/fleet-import";
import * as Result from "effect/Result";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("expo-secure-store", () => import("./fleetEnrollmentKey.secure-store-mock"));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pick }));
vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "read" },
  File: class {
    open = mocks.open;
    delete = mocks.remove;
  },
}));

import { classifyFleetFile, pickFleetImportFile } from "./fleetImportFile";

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
