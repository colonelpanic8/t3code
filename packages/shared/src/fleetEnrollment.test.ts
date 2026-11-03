import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import {
  decodeFleetEnrollment,
  encodeFleetEnrollment,
  FLEET_ENROLLMENT_MAX_BYTES,
} from "./fleetEnrollment.ts";

const credential = (letter: string) => `t3enroll1.${letter.repeat(43)}`;
const alpha = {
  environmentId: "fleet:alpha",
  label: "Alpha",
  httpBaseUrl: "https://alpha.example.test/",
  wsBaseUrl: "wss://alpha.example.test/",
  credential: credential("a"),
  expiresAt: "2027-10-16T00:00:00.000Z",
};
const beta = {
  environmentId: "fleet:beta",
  label: "Beta",
  httpBaseUrl: "http://beta.example.test:3773",
  wsBaseUrl: "ws://beta.example.test:3773",
  credential: credential("b"),
  expiresAt: "2027-11-01T00:00:00.000Z",
};
const document = (...environments: ReadonlyArray<unknown>) => ({
  version: 2,
  type: "t3code.fleet-enrollment",
  environments,
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const failureReason = (value: unknown) => {
  const result = decodeFleetEnrollment(bytes(value));
  return Result.isFailure(result) ? result.failure.reason : "decoded";
};

describe("fleet enrollment codec", () => {
  it("decodes every machine of a bundle with redacted credentials and typed expiries", () => {
    const bundle = document(alpha, beta);
    const decoded = Result.getOrThrow(decodeFleetEnrollment(bytes(bundle)));

    expect(
      decoded.environments.map((entry) => ({
        environment: entry.environment,
        credential: Redacted.value(entry.credential),
        expiresAt: DateTime.formatIso(entry.expiresAt),
      })),
    ).toEqual([
      {
        environment: {
          environmentId: "fleet:alpha",
          label: "Alpha",
          httpBaseUrl: "https://alpha.example.test/",
          wsBaseUrl: "wss://alpha.example.test/",
        },
        credential: credential("a"),
        expiresAt: "2027-10-16T00:00:00.000Z",
      },
      {
        environment: {
          environmentId: "fleet:beta",
          label: "Beta",
          httpBaseUrl: "http://beta.example.test:3773",
          wsBaseUrl: "ws://beta.example.test:3773",
        },
        credential: credential("b"),
        expiresAt: "2027-11-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(decoded)).not.toContain(credential("a"));

    const encoded = Result.getOrThrow(encodeFleetEnrollment(decoded));
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(bundle);
  });

  it.each([
    { name: "a v1 anchor file", value: { ...document(alpha), version: 1 } },
    {
      name: "a v1 anchor shape",
      value: {
        version: 1,
        type: "t3code.fleet-enrollment",
        anchor: { environmentId: "a", label: "A", httpBaseUrl: "https://a", wsBaseUrl: "wss://a" },
        credential: credential("a"),
        expiresAt: alpha.expiresAt,
      },
    },
    { name: "another type", value: { ...document(alpha), type: "t3code.other" } },
    { name: "an unknown top-level key", value: { ...document(alpha), token: credential("a") } },
    { name: "an unknown entry key", value: document({ ...alpha, token: credential("a") }) },
    { name: "no machines", value: document() },
    {
      name: "more than 100 machines",
      value: document(
        ...Array.from({ length: 101 }, (_, index) => ({
          ...alpha,
          environmentId: `fleet:${index}`,
        })),
      ),
    },
    { name: "a one-time token", value: document({ ...alpha, credential: "one-time-token" }) },
    {
      name: "a short credential",
      value: document({ ...alpha, credential: credential("a").slice(1) }),
    },
    { name: "a bad expiry", value: document({ ...alpha, expiresAt: "tomorrow" }) },
  ])("rejects $name as malformed without echoing a credential", ({ value }) => {
    const result = decodeFleetEnrollment(bytes(value));
    expect(Result.isFailure(result) && result.failure.reason).toBe("malformed");
    expect(JSON.stringify(result)).not.toContain(credential("a"));
  });

  it("rejects a bundle that lists one machine twice", () => {
    expect(failureReason(document(alpha, beta, { ...beta, label: "Beta again" }))).toBe(
      "duplicate-environment",
    );
  });

  it.each([
    { httpBaseUrl: `https://alpha.example.test?token=${credential("a")}` },
    { httpBaseUrl: `https://user:${credential("a")}@alpha.example.test` },
    { httpBaseUrl: " https://alpha.example.test" },
    { httpBaseUrl: "https://alpha.example.test:65536" },
    { httpBaseUrl: "https://alpha.example.test/\u0007" },
    { httpBaseUrl: "https://alpha.example.test/t3" },
    { wsBaseUrl: "wss://alpha.example.test/t3" },
    { httpBaseUrl: "https://other.example.test" },
    { httpBaseUrl: "http://alpha.example.test" },
    { httpBaseUrl: "ftp://alpha.example.test", wsBaseUrl: "ws://alpha.example.test" },
  ])("rejects an address that is not a plain matching origin: %o", (addresses) => {
    expect(failureReason(document(beta, { ...alpha, ...addresses }))).toBe("unsafe-url");
  });

  it("rejects oversized plaintext on decode and encode", () => {
    expect(decodeFleetEnrollment(new Uint8Array(FLEET_ENROLLMENT_MAX_BYTES + 1))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "too-large" },
    });
    const [entry] = Result.getOrThrow(decodeFleetEnrollment(bytes(document(alpha)))).environments;
    expect(
      encodeFleetEnrollment({
        environments: [
          {
            ...entry,
            environment: { ...entry.environment, label: "x".repeat(FLEET_ENROLLMENT_MAX_BYTES) },
          },
        ],
      }),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "too-large" } });
  });

  it("refuses to encode what it would refuse to decode", () => {
    const [entry] = Result.getOrThrow(decodeFleetEnrollment(bytes(document(alpha)))).environments;
    expect(
      encodeFleetEnrollment({
        environments: [
          { ...entry, environment: { ...entry.environment, wsBaseUrl: "ws://alpha.example.test" } },
        ],
      }),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe-url" } });
    expect(encodeFleetEnrollment({ environments: [entry, entry] })).toMatchObject({
      _tag: "Failure",
      failure: { reason: "duplicate-environment" },
    });
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
