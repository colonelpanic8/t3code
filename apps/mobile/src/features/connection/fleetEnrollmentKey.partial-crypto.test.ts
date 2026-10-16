import { afterAll, describe, expect, vi } from "vite-plus/test";

import { itDecryptsFleetEnrollmentFiles } from "./fleetEnrollmentKey.test-support";

vi.mock("expo-secure-store", () => import("./fleetEnrollmentKey.secure-store-mock"));

const originalcrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalDOMException = Object.getOwnPropertyDescriptor(globalThis, "DOMException");
afterAll(() => {
  if (originalcrypto) Object.defineProperty(globalThis, "crypto", originalcrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
  if (originalDOMException) Object.defineProperty(globalThis, "DOMException", originalDOMException);
  else Reflect.deleteProperty(globalThis, "DOMException");
});

// A getRandomValues-only polyfill another library may install, without DOMException.
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { getRandomValues: <T extends ArrayBufferView>(array: T) => array },
});
Reflect.deleteProperty(globalThis, "DOMException");

describe("decrypting with crypto lacking subtle and no DOMException", () => {
  expect(globalThis.crypto.subtle).toBeUndefined();
  expect(typeof DOMException).toBe("undefined");
  itDecryptsFleetEnrollmentFiles();
});
