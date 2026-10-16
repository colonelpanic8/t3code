import { describe, expect, vi } from "vite-plus/test";

import { itDecryptsFleetEnrollmentFiles } from "./fleetEnrollmentKey.test-support";

vi.mock("expo-secure-store", () => import("./fleetEnrollmentKey.secure-store-mock"));

// Hermes without any crypto global.
Reflect.deleteProperty(globalThis, "crypto");

describe("decrypting without a crypto global", () => {
  expect(globalThis.crypto).toBeUndefined();
  itDecryptsFleetEnrollmentFiles();
});
