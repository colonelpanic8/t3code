import * as Result from "effect/Result";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pick }));
vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "read" },
  File: class {
    open = mocks.open;
    delete = mocks.remove;
  },
}));

import { pickFleetImportFile } from "./fleetImportFile";

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

  it("leaves files alone when the picker is canceled", async () => {
    mocks.pick.mockResolvedValueOnce({ canceled: true });
    expect(await pickFleetImportFile()).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
