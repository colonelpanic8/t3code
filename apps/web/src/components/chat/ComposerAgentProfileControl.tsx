import type { AgentProfileId } from "@t3tools/contracts";
import { UserRoundCogIcon } from "lucide-react";
import { memo } from "react";

import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const AGENT_PROFILE_DESCRIPTION =
  "An agent profile replaces your user-level instructions, skills, and provider config with the profile's own. Project context still applies.";
// Select values must be strings; profile ids are never blank.
const DEFAULT_PROFILE_VALUE = "";

export interface AgentProfileControlProps {
  readonly agentProfile: AgentProfileId | undefined;
  readonly agentProfiles: ReadonlyArray<AgentProfileId>;
  /** Absent once the thread exists: the profile is fixed at creation. */
  readonly onAgentProfileChange: ((profile: AgentProfileId | null) => void) | undefined;
}

export function showsAgentProfileControl(props: AgentProfileControlProps): boolean {
  return (
    props.agentProfile !== undefined ||
    (props.onAgentProfileChange !== undefined && props.agentProfiles.length > 0)
  );
}

export const ComposerAgentProfileControl = memo(function ComposerAgentProfileControl(
  props: AgentProfileControlProps & {
    readonly size: "sm" | "xs";
    readonly hidden?: boolean | undefined;
  },
) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  if (!showsAgentProfileControl(props)) return null;
  const label = props.agentProfile ?? "Default";

  if (props.onAgentProfileChange === undefined) {
    const tooltip = `Agent profile: ${label}. ${AGENT_PROFILE_DESCRIPTION}`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={props.size}
              className="shrink-0 whitespace-nowrap"
              aria-disabled
              type="button"
              aria-label={tooltip}
            />
          }
        >
          <ComposerControlIcon icon={UserRoundCogIcon} size={props.size} />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const onAgentProfileChange = props.onAgentProfileChange;
  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={props.agentProfile ?? DEFAULT_PROFILE_VALUE}
        onValueChange={(value) =>
          onAgentProfileChange(
            value === null || value === DEFAULT_PROFILE_VALUE ? null : (value as AgentProfileId),
          )
        }
      >
        <TooltipTrigger
          render={<ComposerSelectControl size={props.size} aria-label="Agent profile" />}
        >
          <ComposerControlIcon icon={UserRoundCogIcon} size={props.size} />
          {props.agentProfile === undefined ? null : (
            <SelectValue data-composer-control-label>{label}</SelectValue>
          )}
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          <SelectItem value={DEFAULT_PROFILE_VALUE} hideIndicator className="min-w-48">
            Default
          </SelectItem>
          {props.agentProfiles.map((profile) => (
            <SelectItem key={profile} value={profile} hideIndicator className="min-w-48">
              {profile}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top" className="max-w-72">
        {`Agent profile: ${label}. ${AGENT_PROFILE_DESCRIPTION}`}
      </TooltipPopup>
    </Tooltip>
  );
});
