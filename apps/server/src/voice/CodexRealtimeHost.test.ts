import { assert, describe, it } from "@effect/vitest";

import { codexVersionSupportsRealtime } from "./CodexRealtimeHost.ts";

describe("codexVersionSupportsRealtime", () => {
  it("accepts the floor and anything newer", () => {
    assert.isTrue(codexVersionSupportsRealtime("0.145.0"));
    assert.isTrue(codexVersionSupportsRealtime("0.145.1"));
    assert.isTrue(codexVersionSupportsRealtime("0.146.0"));
    assert.isTrue(codexVersionSupportsRealtime("0.200.3"));
    assert.isTrue(codexVersionSupportsRealtime("1.0.0"));
  });

  it("rejects anything older than 0.145.0", () => {
    assert.isFalse(codexVersionSupportsRealtime("0.144.9"));
    assert.isFalse(codexVersionSupportsRealtime("0.99.0"));
    assert.isFalse(codexVersionSupportsRealtime("0.0.1"));
  });

  it("reads the version out of a longer user-agent fragment", () => {
    assert.isTrue(codexVersionSupportsRealtime("codex-cli 0.145.2 (linux)"));
    assert.isFalse(codexVersionSupportsRealtime("codex-cli 0.144.0 (linux)"));
  });

  it("rejects missing or unparsable versions", () => {
    assert.isFalse(codexVersionSupportsRealtime(undefined));
    assert.isFalse(codexVersionSupportsRealtime(""));
    assert.isFalse(codexVersionSupportsRealtime("nightly"));
  });
});
