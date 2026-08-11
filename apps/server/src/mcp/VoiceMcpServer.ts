import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { VoiceLiveService } from "../voice/VoiceLiveService.ts";
import { normalizeMcpHttpResponse } from "./McpHttpServer.ts";
import { VoiceToolkitHandlersLive } from "./toolkits/voice/handlers.ts";
import { VoiceToolkit } from "./toolkits/voice/tools.ts";
import * as VoiceMcpInvocationContext from "./VoiceMcpInvocationContext.ts";

/**
 * The dedicated MCP transport for Live Voice calls. It is a separate
 * `McpServer.layerHttp` at `/mcp/voice` carrying only the voice routing
 * toolkit: the hidden Codex session's tool catalog can never contain the
 * orchestrator, preview, or worktree tools, and its bearer credential names
 * one live call rather than a provider session.
 */

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_voice_credential",
    message: "A valid Live Voice bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  VoiceMcpInvocationContext.VoiceMcpInvocationContext
>;

type VoiceMcpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeVoiceMcpAuthMiddleware = VoiceLiveService.pipe(
  Effect.map(
    (voiceLive): VoiceMcpAuthMiddleware =>
      Effect.fn("VoiceMcpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const credential = yield* voiceLive.resolveVoiceCredential(token);
        if (!credential) {
          yield* Effect.logWarning("rejected voice MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_revoked_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(VoiceMcpInvocationContext.VoiceMcpInvocationContext, {
            liveSessionId: credential.liveSessionId,
          }),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("VoiceMcpServer.makeAuthMiddleware"),
);

const VoiceMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: VoiceMcpInvocationContext.VoiceMcpInvocationContext;
}>()(makeVoiceMcpAuthMiddleware).layer;

const VoiceMcpTransportLive = McpServer.layerHttp({
  name: "T3 Code Voice",
  version: packageJson.version,
  path: "/mcp/voice",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(VoiceMcpAuthMiddlewareLive));

export const layer = McpServer.toolkit(VoiceToolkit).pipe(
  Layer.provide(VoiceToolkitHandlersLive),
  Layer.provideMerge(VoiceMcpTransportLive),
);
