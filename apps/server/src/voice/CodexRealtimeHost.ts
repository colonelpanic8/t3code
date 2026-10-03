import { VoiceLiveError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { expandHomePath } from "../pathExpansion.ts";

/**
 * A hidden Codex app-server session that hosts one Live Voice call. It is not
 * attached to any T3 project or thread: the Codex thread lives in the Codex
 * home, and none of its events enter the orchestration timeline. Codex's own
 * ChatGPT-subscription (or API-key) auth carries the OpenAI realtime
 * connection; T3 never sees an OpenAI credential.
 */

/** `--enable realtime_conversation` and the v3 WebRTC transport ship in 0.145.0. */
export const CODEX_REALTIME_MIN_VERSION: readonly [number, number, number] = [0, 145, 0];

export function codexVersionSupportsRealtime(version: string | undefined): boolean {
  if (!version) return false;
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let i = 0; i < 3; i += 1) {
    const part = parsed[i] ?? 0;
    const min = CODEX_REALTIME_MIN_VERSION[i] ?? 0;
    if (part > min) return true;
    if (part < min) return false;
  }
  return true;
}

export type CodexRealtimeEvent =
  | { readonly kind: "started"; readonly realtimeVersion: string | null }
  | { readonly kind: "sdp"; readonly sdp: string }
  | {
      readonly kind: "transcript";
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "closed"; readonly reason: string | null };

export interface CodexRealtimeInitialItem {
  readonly role: "user" | "developer" | "assistant";
  readonly text: string;
}

export interface CodexRealtimeStartParams {
  readonly offerSdp: string;
  readonly voice?: string | undefined;
  /** Replaces the realtime model's entire system prompt. */
  readonly prompt: string;
  readonly initialItems?: ReadonlyArray<CodexRealtimeInitialItem>;
}

export interface CodexRealtimeHost {
  readonly codexVersion: string | null;
  readonly start: (params: CodexRealtimeStartParams) => Effect.Effect<void, VoiceLiveError>;
  readonly stop: Effect.Effect<void>;
  readonly appendText: (input: {
    readonly text: string;
    readonly role?: "user" | "developer" | "assistant";
  }) => Effect.Effect<void, VoiceLiveError>;
}

export interface OpenCodexRealtimeHostInput {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Voice-scoped MCP endpoint carrying the routing toolkit, if routing is on. */
  readonly mcp?: { readonly endpoint: string; readonly authorizationHeader: string } | undefined;
  readonly onEvent: (event: CodexRealtimeEvent) => void;
}

const voiceError = (message: string, code: string) => (cause: unknown) =>
  new VoiceLiveError({ message, code, cause });

const transcriptRole = (role: string): "user" | "assistant" =>
  role === "assistant" ? "assistant" : "user";

/** SDP requires CRLF-terminated lines; restore the terminator the RPC contract trims. */
export function ensureSdpLineTermination(sdp: string): string {
  return sdp.endsWith("\n") ? sdp : `${sdp}\r\n`;
}

/**
 * Spawns the app-server, initializes it, verifies auth and the realtime
 * version floor, and starts the hidden Codex thread. The child process dies
 * with the provided Scope; callers own teardown ordering via that scope.
 */
export const openCodexRealtimeHost = Effect.fn("openCodexRealtimeHost")(function* (
  input: OpenCodexRealtimeHostInput,
): Effect.fn.Return<
  CodexRealtimeHost,
  VoiceLiveError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const environment = {
    ...input.environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    ["app-server", "--enable", "realtime_conversation"],
    { env: environment, extendEnv: true },
  ).pipe(Effect.mapError(voiceError("Could not resolve the Codex binary.", "codex_unavailable")));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: "2 seconds",
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        voiceError(
          "Codex failed to launch with realtime support. If Codex is older than 0.145.0, update it.",
          "codex_launch_failed",
        ),
      ),
    );

  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  // The child exiting for any reason must read as a terminal event, or a call
  // whose Codex died mid-session would hang silently.
  yield* Effect.forkScoped(
    child.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(Effect.sync(() => input.onEvent({ kind: "closed", reason: "codex_exited" }))),
    ),
  );

  const initialize = yield* client
    .request("initialize", {
      clientInfo: { name: "t3code", title: "T3 Code", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    })
    .pipe(
      Effect.mapError(
        voiceError(
          "Codex rejected startup. If Codex is older than 0.145.0 it does not support realtime voice; update it.",
          "codex_too_old",
        ),
      ),
    );
  yield* client.notify("initialized", undefined).pipe(Effect.orDie);

  const codexVersion = initialize.userAgent.match(/\/([^\s]+)/)?.[1] ?? null;
  if (!codexVersionSupportsRealtime(codexVersion ?? undefined)) {
    return yield* new VoiceLiveError({
      message: `Codex ${codexVersion ?? "(unknown version)"} does not support realtime voice; 0.145.0 or newer is required.`,
      code: "codex_too_old",
    });
  }

  const account = yield* client
    .request("account/read", {})
    .pipe(Effect.mapError(voiceError("Could not read Codex auth state.", "codex_unavailable")));
  if (!account.account && account.requiresOpenaiAuth) {
    return yield* new VoiceLiveError({
      message: "Codex is not signed in. Run `codex login` and try again.",
      code: "unauthenticated",
    });
  }

  const thread = yield* client
    .request("thread/start", {
      cwd: input.cwd,
      ...(input.mcp === undefined
        ? {}
        : {
            config: {
              mcp_servers: {
                "t3-code-voice": {
                  url: input.mcp.endpoint,
                  http_headers: { Authorization: input.mcp.authorizationHeader },
                },
              },
            },
          }),
    })
    .pipe(
      Effect.mapError(
        voiceError("Codex could not start the voice session thread.", "codex_unavailable"),
      ),
    );
  const codexThreadId = thread.thread.id;

  const forThisThread = (threadId: string) => threadId === codexThreadId;
  yield* client.handleServerNotification("thread/realtime/started", (params) =>
    Effect.sync(() => {
      if (!forThisThread(params.threadId)) return;
      input.onEvent({ kind: "started", realtimeVersion: params.version ?? null });
    }),
  );
  yield* client.handleServerNotification("thread/realtime/sdp", (params) =>
    Effect.sync(() => {
      if (!forThisThread(params.threadId)) return;
      input.onEvent({ kind: "sdp", sdp: params.sdp });
    }),
  );
  yield* client.handleServerNotification("thread/realtime/transcript/done", (params) =>
    Effect.sync(() => {
      if (!forThisThread(params.threadId)) return;
      input.onEvent({ kind: "transcript", role: transcriptRole(params.role), text: params.text });
    }),
  );
  yield* client.handleServerNotification("thread/realtime/error", (params) =>
    Effect.sync(() => {
      if (!forThisThread(params.threadId)) return;
      input.onEvent({ kind: "error", message: params.message });
    }),
  );
  yield* client.handleServerNotification("thread/realtime/closed", (params) =>
    Effect.sync(() => {
      if (!forThisThread(params.threadId)) return;
      input.onEvent({ kind: "closed", reason: params.reason ?? null });
    }),
  );

  const start: CodexRealtimeHost["start"] = (params) =>
    client.raw
      .request("thread/realtime/start", {
        threadId: codexThreadId,
        outputModality: "audio",
        version: "v3",
        // The RPC contract trims the offer, dropping the SDP's trailing CRLF;
        // OpenAI's parser requires every line terminated and rejects the
        // unterminated form with "unmarshal SDP: EOF".
        transport: { type: "webrtc", sdp: ensureSdpLineTermination(params.offerSdp) },
        prompt: params.prompt,
        // The prompt above owns all instructions; Codex's synthesized startup
        // context would compete with it.
        includeStartupContext: false,
        ...(params.voice === undefined ? {} : { voice: params.voice }),
        ...(params.initialItems?.length ? { initialItems: params.initialItems } : {}),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          voiceError("Codex refused to start the realtime conversation.", "realtime_start_failed"),
        ),
      );

  const stop: CodexRealtimeHost["stop"] = client.raw
    .request("thread/realtime/stop", { threadId: codexThreadId })
    .pipe(Effect.asVoid, Effect.ignore);

  const appendText: CodexRealtimeHost["appendText"] = (params) =>
    client.raw
      .request("thread/realtime/appendText", {
        threadId: codexThreadId,
        text: params.text,
        ...(params.role === undefined ? {} : { role: params.role }),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(voiceError("Codex rejected the appended text.", "realtime_append_failed")),
      );

  return { codexVersion, start, stop, appendText };
});
