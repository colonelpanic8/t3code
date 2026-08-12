import { AudioLinesIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import {
  startVoiceLiveCall,
  VOICE_LIVE_INSECURE_CONTEXT_REASON,
} from "./voiceLiveSession";
import { useVoiceLiveStore } from "./voiceLiveStore";

/**
 * Sidebar-footer launcher for Live Voice. Lists connected environments whose
 * server advertises the `voiceLive` capability; explains itself when disabled
 * instead of failing silently.
 */
export const VoiceLiveButton = memo(function VoiceLiveButton() {
  const { environments } = useEnvironments();
  const status = useVoiceLiveStore((state) => state.status);
  const { isMobile, setOpenMobile } = useSidebar();

  const eligibleHosts = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.voiceLive === true &&
          environment.connection.phase === "connected",
      ),
    [environments],
  );

  const startCall = useCallback(
    (host: EnvironmentPresentation) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void startVoiceLiveCall({ environmentId: host.environmentId, label: host.label });
    },
    [isMobile, setOpenMobile],
  );

  const callActive = status === "connecting" || status === "active";
  const disabledReason = callActive
    ? "A call is already active"
    : !window.isSecureContext
      ? VOICE_LIVE_INSECURE_CONTEXT_REASON
      : eligibleHosts.length === 0
        ? "No connected host supports Live Voice"
        : null;

  if (disabledReason !== null) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton disabled title={disabledReason}>
          <AudioLinesIcon />
          <span>Live Voice</span>
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
            {disabledReason}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  if (eligibleHosts.length === 1) {
    const host = eligibleHosts[0]!;
    return (
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => startCall(host)} title={`Start a call on ${host.label}`}>
          <AudioLinesIcon />
          <span>Live Voice</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <Menu>
        <MenuTrigger render={<SidebarMenuButton />}>
          <AudioLinesIcon />
          <span>Live Voice</span>
        </MenuTrigger>
        <MenuPopup align="start" side="top">
          {eligibleHosts.map((host) => (
            <MenuItem key={host.environmentId} onClick={() => startCall(host)}>
              <span className="truncate">{host.label}</span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
});
