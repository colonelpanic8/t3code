import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import fleetFixture from "./fixtures/fleet-manifest.v1.json" with { type: "json" };
import { decodeFleetImport, FLEET_IMPORT_MAX_BYTES } from "./fleetImport.ts";

const fixtureText = JSON.stringify(fleetFixture, null, 2);

const alpha = {
  environmentId: "fleet:alpha",
  label: "Alpha",
  httpBaseUrl: "https://alpha.example.test",
  wsBaseUrl: "wss://alpha.example.test",
};

function fleetFile(environments: ReadonlyArray<object>, extra: object = {}): string {
  return JSON.stringify({ version: 1, environments, ...extra });
}

function failureReason(source: Uint8Array | string) {
  const result = decodeFleetImport(source);
  return Result.isFailure(result) ? result.failure.reason : null;
}

describe("decodeFleetImport", () => {
  it("decodes the committed fleet file from its text and from picked bytes", () => {
    const expected = [
      alpha,
      {
        environmentId: "fleet:beta",
        label: "Beta",
        httpBaseUrl: "http://beta.example.test:3773",
        wsBaseUrl: "ws://beta.example.test:3773",
      },
    ];
    expect(decodeFleetImport(fixtureText)).toEqual(Result.succeed(expected));
    expect(decodeFleetImport(new TextEncoder().encode(fixtureText))).toEqual(
      Result.succeed(expected),
    );
  });

  it("accepts a base path on the declared address", () => {
    const result = decodeFleetImport(
      fleetFile([
        {
          ...alpha,
          httpBaseUrl: "https://alpha.example.test/t3",
          wsBaseUrl: "wss://alpha.example.test/t3",
        },
      ]),
    );
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("rejects files that are not a version 1 fleet file", () => {
    expect(failureReason("not json")).toBe("malformed");
    expect(failureReason("[]")).toBe("malformed");
    expect(failureReason(JSON.stringify({ version: 2, environments: [alpha] }))).toBe("malformed");
    expect(failureReason(fleetFile([{ ...alpha, label: " " }]))).toBe("malformed");
    expect(failureReason(fleetFile([{ ...alpha, environmentId: undefined }]))).toBe("malformed");
  });

  it("rejects unknown keys anywhere instead of dropping them", () => {
    expect(failureReason(fleetFile([alpha], { token: "secret-token" }))).toBe("malformed");
    expect(failureReason(fleetFile([{ ...alpha, token: "secret-token" }]))).toBe("malformed");
    expect(failureReason(fleetFile([{ ...alpha, credential: { $file: "/run/token" } }]))).toBe(
      "malformed",
    );
  });

  it("never repeats the file's contents in its error", () => {
    const result = decodeFleetImport(fleetFile([{ ...alpha, token: "secret-token" }]));
    expect(Result.isFailure(result) && result.failure.message).not.toContain("secret-token");
  });

  it("bounds the file size and the environment count", () => {
    expect(failureReason(new Uint8Array(FLEET_IMPORT_MAX_BYTES + 1))).toBe("too-large");
    expect(failureReason(fleetFile([alpha], { padding: "x".repeat(FLEET_IMPORT_MAX_BYTES) }))).toBe(
      "too-large",
    );
    expect(failureReason(fleetFile([]))).toBe("empty");
    const many = Array.from({ length: 101 }, (_, index) => ({
      ...alpha,
      environmentId: `fleet:${index}`,
    }));
    expect(failureReason(fleetFile(many))).toBe("too-many");
    expect(Result.isSuccess(decodeFleetImport(fleetFile(many.slice(0, 100))))).toBe(true);
  });

  it("rejects an environment listed twice", () => {
    expect(failureReason(fleetFile([alpha, { ...alpha, label: "Alpha again" }]))).toBe(
      "duplicate-environment",
    );
  });

  it.each([
    ["a pairing link", "https://alpha.example.test/#token=abc", "wss://alpha.example.test"],
    ["a query token", "https://alpha.example.test/pair?token=abc", "wss://alpha.example.test"],
    ["an empty query", "https://alpha.example.test/?", "wss://alpha.example.test"],
    ["userinfo", "https://user:pass@alpha.example.test", "wss://alpha.example.test"],
    ["surrounding whitespace", " https://alpha.example.test", "wss://alpha.example.test"],
    ["a control character", "https://alpha.example.test/\u0007", "wss://alpha.example.test"],
    ["a backslash", "https:\\\\alpha.example.test", "wss://alpha.example.test"],
    ["a missing authority marker", "https:alpha.example.test", "wss://alpha.example.test"],
    ["a non-http scheme", "file:///etc/passwd", "wss://alpha.example.test"],
    ["an http websocket address", "https://alpha.example.test", "https://alpha.example.test"],
    ["TLS on one side only", "https://alpha.example.test", "ws://alpha.example.test"],
    ["another host", "https://alpha.example.test", "wss://evil.example.test"],
    ["another port", "http://alpha.example.test:3773", "ws://alpha.example.test:3774"],
  ])("rejects %s", (_, httpBaseUrl, wsBaseUrl) => {
    expect(failureReason(fleetFile([{ ...alpha, httpBaseUrl, wsBaseUrl }]))).toBe("unsafe-url");
  });
});
