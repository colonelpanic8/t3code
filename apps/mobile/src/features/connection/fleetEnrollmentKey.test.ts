import { decodeFleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  decryptFleetEnrollmentFile,
  importEnrollmentIdentity,
  isAgeEncryptedFile,
  loadEnrollmentIdentity,
  removeEnrollmentIdentity,
} from "./fleetEnrollmentKey";
import {
  failureReason,
  fixture,
  fixtureText,
  itDecryptsFleetEnrollmentFiles,
  phoneIdentity,
  run,
} from "./fleetEnrollmentKey.test-support";

vi.mock("expo-secure-store", () => import("./fleetEnrollmentKey.secure-store-mock"));

const phoneRecipient = fixtureText("phone.pub").trim();

describe("decrypting with WebCrypto", () => {
  itDecryptsFleetEnrollmentFiles();

  it("yields a document the shared decoder accepts", async () => {
    const result = await run(decryptFleetEnrollmentFile(fixture("mixed.age")));
    const enrollment = Result.isSuccess(result) ? decodeFleetEnrollment(result.success) : null;
    expect(enrollment !== null && Result.isSuccess(enrollment)).toBe(true);
  });

  it("imports a whole age-keygen file and reports its recipient", async () => {
    await run(removeEnrollmentIdentity());
    const imported = await run(
      importEnrollmentIdentity(Redacted.make(fixtureText("phone-identity.txt"))),
    );
    expect(Result.isSuccess(imported) && imported.success.recipient).toBe(phoneRecipient);
    const loaded = await run(loadEnrollmentIdentity());
    expect(Result.isSuccess(loaded) && Option.getOrNull(loaded.success)?.recipient).toBe(
      phoneRecipient,
    );
  });

  it("keeps the saved identity when an invalid one is pasted, without echoing it", async () => {
    const pasted = `${phoneIdentity.slice(0, -1)}Q`;
    const result = await run(importEnrollmentIdentity(Redacted.make(pasted)));
    expect(failureReason(result)).toBe("invalid");
    expect(Result.isFailure(result) && JSON.stringify(result.failure)).not.toContain(pasted);
    expect(Result.isFailure(result) && result.failure.message).not.toContain(pasted.slice(16));
    expect(Result.isSuccess(await run(decryptFleetEnrollmentFile(fixture("mixed.age"))))).toBe(
      true,
    );
  });

  it("asks for an identity once it is removed", async () => {
    await run(removeEnrollmentIdentity());
    expect(await run(loadEnrollmentIdentity())).toEqual(Result.succeed(Option.none()));
    expect(failureReason(await run(decryptFleetEnrollmentFile(fixture("mixed.age"))))).toBe(
      "no-identity",
    );
  });

  it("tells age files from plain fleet files", () => {
    expect(isAgeEncryptedFile(fixture("mixed.age"))).toBe(true);
    expect(isAgeEncryptedFile(fixture("mixed.bin"))).toBe(true);
    expect(isAgeEncryptedFile(fixture("enrollment-plaintext.txt"))).toBe(false);
  });
});
