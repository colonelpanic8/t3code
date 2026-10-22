import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FLEET_ENROLLMENT_MAX_BYTES } from "@t3tools/shared/fleetEnrollment";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { beforeEach, expect, it } from "vite-plus/test";

import { decryptFleetEnrollmentFile, importEnrollmentIdentity } from "./fleetEnrollmentKey";

/**
 * Decryption cases shared by one test file per JavaScript runtime shape. Noble
 * probes for an RNG when it loads, and the key module loads typage lazily, so
 * each file sets its globals at the top level and relies on Vitest running
 * every file in a fresh process.
 * Vitest also fails the run on unhandled rejections, which unpatched typage
 * leaves behind when `crypto` lacks `subtle`.
 */

const FIXTURES = NodePath.join(__dirname, "fixtures", "fleet-enrollment");
export const fixture = (name: string) =>
  new Uint8Array(NodeFS.readFileSync(NodePath.join(FIXTURES, name)));
export const fixtureText = (name: string) =>
  NodeFS.readFileSync(NodePath.join(FIXTURES, name), "utf8");
export const phoneIdentity = fixtureText("phone-identity.txt").match(/AGE-SECRET-KEY-1\S+/)![0];

export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));
export const failureReason = <A>(result: Result.Result<A, { readonly reason: string }>) =>
  Result.isFailure(result) ? result.failure.reason : "succeeded";

export function itDecryptsFleetEnrollmentFiles() {
  const decrypt = (bytes: Uint8Array) => run(decryptFleetEnrollmentFile(bytes));

  beforeEach(async () => {
    const imported = await run(importEnrollmentIdentity(Redacted.make(phoneIdentity)));
    expect(Result.isSuccess(imported)).toBe(true);
  });

  it.each(["mixed.age", "mixed.bin"])(
    "opens %s, encrypted to SSH and age recipients",
    async (name) => {
      const result = await decrypt(fixture(name));
      expect(Result.isSuccess(result) && new TextDecoder().decode(result.success)).toBe(
        fixtureText("enrollment-plaintext.txt"),
      );
    },
  );

  it("rejects a file for other recipients", async () => {
    expect(failureReason(await decrypt(fixture("other-only.age")))).toBe("not-a-recipient");
  });

  it("rejects a tampered file", async () => {
    const tampered = fixture("mixed.bin");
    tampered[tampered.length - 5]! ^= 1;
    expect(failureReason(await decrypt(tampered))).toBe("corrupt");
  });

  it("stops reading plaintext past the enrollment size cap", async () => {
    expect(fixture("oversize.bin").byteLength).toBeGreaterThan(FLEET_ENROLLMENT_MAX_BYTES);
    expect(failureReason(await decrypt(fixture("oversize.bin")))).toBe("too-large");
  });
}
