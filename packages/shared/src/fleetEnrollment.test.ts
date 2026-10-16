import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import {
  decodeFleetEnrollment,
  encodeFleetEnrollment,
  FLEET_ENROLLMENT_MAX_BYTES,
} from "./fleetEnrollment.ts";

const credential = `t3enroll1.${"a".repeat(43)}`;
const document = {
  version: 1,
  type: "t3code.fleet-enrollment",
  anchor: {
    environmentId: "fleet:alpha",
    label: "Alpha",
    httpBaseUrl: "https://alpha.example.test/t3",
    wsBaseUrl: "wss://alpha.example.test/t3",
  },
  credential,
  expiresAt: "2027-10-16T00:00:00.000Z",
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("fleet enrollment codec", () => {
  it("round-trips a credential with a redacted in-memory value and a typed expiry", () => {
    const decoded = Result.getOrThrow(decodeFleetEnrollment(bytes(document)));
    expect(decoded.anchor).toEqual(document.anchor);
    expect(Redacted.value(decoded.credential)).toBe(credential);
    expect(JSON.stringify(decoded)).not.toContain(credential);
    expect(DateTime.formatIso(decoded.expiresAt)).toBe(document.expiresAt);
    const encoded = Result.getOrThrow(encodeFleetEnrollment(decoded));
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(document);
    expect(decodeFleetEnrollment(encoded)).toEqual(Result.succeed(decoded));
  });

  it.each([
    { ...document, version: 2 },
    { ...document, type: "t3code.other" },
    { ...document, unexpected: credential },
    { ...document, anchor: { ...document.anchor, token: credential } },
    { ...document, credential: "one-time-token" },
    { ...document, credential: `t3enroll1.${"a".repeat(42)}` },
    { ...document, credential: `t3enroll1.${"a".repeat(43)}\n` },
    { ...document, expiresAt: "tomorrow" },
  ])("rejects malformed or unexpected fields without echoing the credential", (value) => {
    const result = decodeFleetEnrollment(bytes(value));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("malformed");
      expect(result.failure.message).not.toContain(credential);
      expect(JSON.stringify(result.failure)).not.toContain(credential);
    }
  });

  it.each([
    `https://alpha.example.test?token=${credential}`,
    `https://user:${credential}@alpha.example.test`,
    " https://alpha.example.test",
    "https://alpha.example.test:65536",
    "https://alpha.example.test/\u0007",
    "https://other.example.test",
    "http://alpha.example.test",
  ])("rejects unsafe or mismatched anchor addresses", (httpBaseUrl) => {
    expect(
      decodeFleetEnrollment(bytes({ ...document, anchor: { ...document.anchor, httpBaseUrl } })),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe-url" } });
  });

  it("rejects oversized plaintext on decode and encode", () => {
    expect(decodeFleetEnrollment(new Uint8Array(FLEET_ENROLLMENT_MAX_BYTES + 1))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "too-large" },
    });
    const enrollment = Result.getOrThrow(decodeFleetEnrollment(bytes(document)));
    expect(
      encodeFleetEnrollment({
        ...enrollment,
        anchor: { ...enrollment.anchor, label: "x".repeat(FLEET_ENROLLMENT_MAX_BYTES) },
      }),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "too-large" } });
    expect(
      encodeFleetEnrollment({
        ...enrollment,
        anchor: { ...enrollment.anchor, wsBaseUrl: "ws://alpha.example.test" },
      }),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe-url" } });
  });

  it("rejects malformed JSON and invalid UTF-8", () => {
    for (const input of [new TextEncoder().encode("{"), Uint8Array.of(0xff)]) {
      expect(decodeFleetEnrollment(input)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "malformed" },
      });
    }
  });
});
