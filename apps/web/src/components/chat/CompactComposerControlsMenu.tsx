import { type AgentProfileId, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode, useRef } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import {
  type AgentProfileControlProps,
  showsAgentProfileControl,
} from "./ComposerAgentProfileControl";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  showPermissions?: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Set while the profile block is folded into this menu. */
  agentProfile?: AgentProfileControlProps;
}) {
  const agentProfile = props.agentProfile;
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={
              [
                props.showPermissions !== false ? "composer.mode" : null,
                props.traitsMenuContent ? "composer.effort" : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            {props.showInteractionModeToggle || props.showPermissions !== false ? (
              <MenuDivider />
            ) : null}
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default" closeOnClick>
                Chat
              </MenuRadioItem>
              <MenuRadioItem value="plan" closeOnClick>
                Plan
              </MenuRadioItem>
            </MenuRadioGroup>
            {props.showPermissions !== false ? <MenuDivider /> : null}
          </>
        ) : null}
        {props.showPermissions === false ? null : (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        )}
        {agentProfile !== undefined && showsAgentProfileControl(agentProfile) ? (
          <>
            {props.traitsMenuContent ||
            props.showInteractionModeToggle ||
            props.showPermissions !== false ? (
              <MenuDivider />
            ) : null}
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Profile</div>
            <MenuRadioGroup
              value={agentProfile.agentProfile ?? ""}
              onValueChange={(value) =>
                agentProfile.onAgentProfileChange?.(value ? (value as AgentProfileId) : null)
              }
            >
              <MenuRadioItem value="" disabled={agentProfile.onAgentProfileChange === undefined}>
                Default
              </MenuRadioItem>
              {(agentProfile.onAgentProfileChange === undefined
                ? [agentProfile.agentProfile!]
                : agentProfile.agentProfiles
              ).map((profile) => (
                <MenuRadioItem
                  key={profile}
                  value={profile}
                  disabled={agentProfile.onAgentProfileChange === undefined}
                >
                  {profile}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
