import { assert, describe, it } from "@effect/vitest";
import {
  codexVersionSupportsRealtime,
  ensureSdpLineTermination,
  voiceThreadConfig,
} from "./CodexRealtimeHost.ts";
describe("ensureSdpLineTermination", () => {
  it("restores the trailing CRLF the RPC contract trims off", () => {
    assert.strictEqual(
      ensureSdpLineTermination("v=0\r\na=sctp-port:5000"),
      "v=0\r\na=sctp-port:5000\r\n",
    );
  });
  it("leaves already-terminated offers untouched", () => {
    assert.strictEqual(ensureSdpLineTermination("v=0\r\n"), "v=0\r\n");
    assert.strictEqual(ensureSdpLineTermination("v=0\n"), "v=0\n");
  });
});
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
describe("voiceThreadConfig", () => {
  const userConfig = {
    model: "gpt-5",
    mcp_servers: {
      gmessages: {
        command: "gmessages",
      },
      nixos: {
        command: "mcp-nixos",
      },
    },
    plugins: {
      "computer-use@openai-bundled": {
        enabled: true,
      },
    },
  };
  it("switches off the user's servers and plugins and preapproves the voice server", () => {
    assert.deepStrictEqual(
      voiceThreadConfig(userConfig, {
        endpoint: "http://127.0.0.1:3773/mcp/voice",
        authorizationHeader: "Bearer voice-token",
      }),
      {
        mcp_servers: {
          gmessages: {
            enabled: false,
          },
          nixos: {
            enabled: false,
          },
          "t3-code-voice": {
            url: "http://127.0.0.1:3773/mcp/voice",
            http_headers: {
              Authorization: "Bearer voice-token",
            },
            default_tools_approval_mode: "approve",
          },
        },
        plugins: {
          "computer-use@openai-bundled": {
            enabled: false,
          },
        },
        features: {
          apps: false,
        },
      },
    );
  });
  it("still isolates the thread when routing is off", () => {
    assert.deepStrictEqual(voiceThreadConfig(userConfig, undefined), {
      mcp_servers: {
        gmessages: {
          enabled: false,
        },
        nixos: {
          enabled: false,
        },
      },
      plugins: {
        "computer-use@openai-bundled": {
          enabled: false,
        },
      },
      features: {
        apps: false,
      },
    });
  });
});
