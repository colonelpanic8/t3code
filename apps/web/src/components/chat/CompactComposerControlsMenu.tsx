import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { cloneElement, memo, type ReactElement, useCallback } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactElement | null | undefined;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onSelectionComplete: () => void;
}) {
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { onSelectionComplete } = props;
  const completeSelection = useCallback(() => {
    setOpen(false);
    onSelectionComplete();
  }, [onSelectionComplete, setOpen]);
  const traitsMenuContent = props.traitsMenuContent
    ? cloneElement(props.traitsMenuContent as ReactElement<{ onSelectionComplete?: () => void }>, {
        onSelectionComplete: completeSelection,
      })
    : null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            variant="ghost"
            className={size === "xs" ? "shrink-0" : "shrink-0 px-2"}
            aria-label="More composer controls"
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {traitsMenuContent ? (
          <>
            {traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value) return;
                if (value !== props.interactionMode) {
                  props.onToggleInteractionMode();
                }
                completeSelection();
              }}
            >
              <MenuRadioItem closeOnClick value="default">
                Chat
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="plan">
                Plan
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value) return;
            if (value !== props.runtimeMode) {
              props.onRuntimeModeChange(value as RuntimeMode);
            }
            completeSelection();
          }}
        >
          <MenuRadioItem closeOnClick value="approval-required">
            Supervised
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="auto-accept-edits">
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="auto">
            Auto
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="full-access">
            Full access
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
