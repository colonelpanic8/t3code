import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
  VoiceLiveSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import { VoiceLiveService } from "../voice/VoiceLiveService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as VoiceMcpServer from "./VoiceMcpServer.ts";
const providerToken = "provider-token";
const voiceToken = "voice-token";
const MainToolkit = Toolkit.make(
  Tool.make("main_probe", {
    description: "A tool that belongs only to /mcp.",
    success: Schema.Struct({
      ok: Schema.Boolean,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);
const mainServer = McpHttpServer.toolkitRegistration(
  MainToolkit,
  McpToolAccess.toLayer(MainToolkit, {
    main_probe: McpToolAccess.reads(() =>
      Effect.succeed({
        ok: true,
      }),
    ),
  }),
).pipe(
  Layer.provideMerge(McpHttpServer.layerMcpTransport),
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (token) =>
        Effect.succeed(
          token === providerToken
            ? {
                environmentId: EnvironmentId.make("environment-voice-test"),
                requestNamespace: "provider-session",
                thread: {
                  threadId: ThreadId.make("thread-voice-test"),
                  providerSessionId: "provider-session",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration"] as const),
                issuedAt: 1,
              }
            : undefined,
        ),
    }),
  ),
);
const voiceLiveService = Layer.mock(VoiceLiveService)({
  resolveVoiceCredential: (token) =>
    Effect.succeed(
      token === voiceToken
        ? {
            liveSessionId: VoiceLiveSessionId.make("live-session-test"),
          }
        : undefined,
    ),
});
it.effect("keeps the /mcp and /mcp/voice tool catalogs apart", () =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(
      Layer.mergeAll(mainServer, VoiceMcpServer.layer.pipe(Layer.provide(voiceLiveService))),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(Layer.build);
    const httpClient = yield* HttpClient.HttpClient;
    const listTools = Effect.fn(function* (path: string, token: string) {
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      const initialize = yield* httpClient.post(path, {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initialize.headers["mcp-session-id"];
      const response = yield* httpClient.post(path, {
        headers: {
          ...headers,
          ...(sessionId === undefined
            ? {}
            : {
                "mcp-session-id": sessionId,
              }),
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, "application/json"),
      });
      const body = (yield* response.json) as {
        result: {
          tools: Array<{
            name: string;
          }>;
        };
      };
      return body.result.tools.map((tool) => tool.name).toSorted();
    });
    expect(yield* listTools("/mcp", providerToken)).toEqual(["main_probe"]);
    expect(yield* listTools("/mcp/voice", voiceToken)).toEqual([
      "find_project",
      "list_hosts",
      "run_t3_tool_on_all_hosts",
      "run_t3_tool_on_host",
    ]);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
