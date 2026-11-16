import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentProfileList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:agent-profiles",
  tag: WS_METHODS.serverListAgentProfiles,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});
