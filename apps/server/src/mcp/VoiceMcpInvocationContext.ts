import type { VoiceLiveSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * Per-request scope for the voice MCP transport (`/mcp/voice`). Deliberately
 * tiny: a voice credential names one live call and nothing else — no thread,
 * no provider session, no capability set to widen.
 */
export interface VoiceMcpInvocationScope {
  readonly liveSessionId: VoiceLiveSessionId;
}

export class VoiceMcpInvocationContext extends Context.Service<
  VoiceMcpInvocationContext,
  VoiceMcpInvocationScope
>()("t3/mcp/VoiceMcpInvocationContext") {}
