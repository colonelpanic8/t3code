# Live Voice

Live Voice is an app-global realtime speech-to-speech mode: the user talks to a
voice model that can see and act on every T3 environment their client is
connected to — a chief of staff across all hosts. It rides on Codex's
experimental realtime API, so it uses the user's existing ChatGPT-subscription
(or API-key) Codex auth. T3 never holds an OpenAI credential for this path.

## Call architecture

- Media flows **client ↔ OpenAI** over WebRTC. The T3 server carries only SDP,
  control messages, finalized transcripts, and routed tool calls.
- Each call runs in a **hidden Codex app-server session**
  (`apps/server/src/voice/CodexRealtimeHost.ts`): a dedicated
  `codex app-server --enable realtime_conversation` child process with its own
  Codex-internal thread, not attached to any T3 project or thread. Nothing it
  does enters the durable orchestration timeline — the whole domain is plain
  RPC + in-memory state, like preview automation.
- Codex 0.145.0 is the floor for `realtime_conversation` and the v3 WebRTC
  transport. Older binaries fail the call with `code: "codex_too_old"`; the
  capability flag below keeps older *servers* from being probed at all.

## Wire protocol (`packages/contracts/src/voice.ts`, `rpc.ts`)

- `voice.live.start` — command-shaped **stream** RPC. Payload carries the
  client's WebRTC offer SDP. Events (`VoiceLiveStreamEvent`, monotonic `seq`):
  `started`, `answer` (the SDP answer), `transcript`, `routeRequest`, `error`,
  `closed`. The call lives exactly as long as this stream: interrupting it (or
  losing the socket) converges on idempotent teardown of the Codex child, the
  MCP credential, and all pending route requests.
- `voice.live.stop` — explicit stop; equivalent to interrupting the stream.
- `voice.live.respond` — the owning client answers a `routeRequest` event
  (host list or routed tool result).
- `voice.live.tool.execute` — executed **on a target host** by the routing
  client; runs one tool from the server-defined catalog below.
- Capabilities in `ExecutionEnvironmentCapabilities`: `voiceLive` (host can run
  calls) and `voiceLiveToolExecution` (host executes routed tools). Absent
  means unsupported; clients must not probe.
- All four methods require `orchestration:operate`.

## Acting across hosts

The voice model's only tools are a restricted routing toolkit served on a
dedicated MCP transport (`/mcp/voice`) with a voice-scoped bearer credential —
it cannot reach the orchestrator/preview/worktree toolkits, and the routing
tools cannot recursively acquire Live Voice.

- `list_hosts` — routed to the owning client, which reports its connected
  environments (sanitized label + status + capability only; endpoints,
  credentials, and relay details never cross the route).
- `run_t3_tool_on_host` — the owning client executes `voice.live.tool.execute`
  against the chosen environment over its own authenticated socket. No caller
  agent identity or workspace authority is inherited; the target host enforces
  its normal RPC scopes.
- `run_t3_tool_on_all_hosts` — read-only fan-out of one tool over every ready
  host, one result per host, unreachable hosts reported by name.
- `find_project` — resolves a spoken project name to exact (environment,
  project) targets by fanning `list_projects` over every ready host and
  matching titles and directory names with speech-forgiving normalization. Its
  resolution (`unique_exact` … `none`) tells the model how confident it may be
  before acting.

The routed tool catalog is defined server-side
(`apps/server/src/voice/VoiceLiveToolExecutor.ts`) and deliberately curated:

| tool | kind | backing |
| --- | --- | --- |
| `list_projects` | read | project registry |
| `list_threads` | read | thread shells (status, title, activity) |
| `read_thread` | read | bounded conversation tail |
| `thread_status` | read | run/turn status for one thread |
| `start_thread` | act | `ThreadLaunchService.launch` (like scheduled tasks) |
| `send_message` | act | `ThreadManagementService.sendToThread` |
| `interrupt_thread` | act | `ThreadManagementService.interruptThread` |

Reads may fan out; mutations run on one named host only, so a spoken request
never mutates several machines at once.

## Ownership and lifecycle

- A call is owned by the exact client socket that started it (per-socket
  `makeWsRpcLayer` closure + `RpcClientId`), at most one call per socket.
- Client stop, socket loss, Codex error/exit, and startup failure all converge
  on the same idempotent cleanup: stop the realtime conversation, kill the
  Codex child (scope close), revoke the voice MCP credential, fail pending
  route requests, emit terminal `closed`.
- The voice model receives a Live Voice prompt plus a bounded snapshot of the
  hosting server's projects and active threads as initial conversation items;
  snapshot build failure degrades to the prompt alone rather than failing the
  call.

## Clients

- Web/desktop: browser WebRTC (`getUserMedia` audio + data channel), launcher
  in the sidebar footer, an active-call surface that follows navigation,
  transcript preview, mute (local track toggle), stop. The cross-host router
  lives in shared client code and executes routed requests against the
  client's other connected environments (`runInEnvironment`).
- Mobile: react-native-webrtc; microphone permission and background-audio
  configuration are added via Expo config plugins (this changes the native
  fingerprint, so it ships with a new binary, not OTA). Foreground calls are
  fully supported; background continuation uses the iOS `audio` background
  mode and an Android foreground service.
- `getUserMedia` requires a secure context: over plain-HTTP LAN origins the
  launcher explains the limitation instead of failing silently.
