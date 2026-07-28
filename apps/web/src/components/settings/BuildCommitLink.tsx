import {
  BUILD_COMMIT,
  BUILD_COMMIT_SHORT,
  BUILD_COMMIT_URL,
  BUILD_DATE,
  BUILD_DIRTY,
  BUILD_REPO_LABEL,
} from "../../buildProvenance";
import { formatCommitDate } from "@t3tools/shared/buildProvenance";
import { ExternalLink } from "../ExternalLink";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COMMIT_CLASS = "font-mono text-[11px] text-muted-foreground";

/**
 * The commit this build came from, linked to it on the host it was built from.
 *
 * Renders nothing when the build carries no provenance, which is the normal
 * state for a build made outside a checkout without `T3CODE_BUILD_*` set.
 */
export function BuildCommitLink() {
  if (!BUILD_COMMIT) return null;

  const label = `${BUILD_COMMIT_SHORT}${BUILD_DIRTY ? "-modified" : ""}`;
  const tooltip = [
    BUILD_REPO_LABEL ? `${BUILD_REPO_LABEL}@${BUILD_COMMIT}` : BUILD_COMMIT,
    formatCommitDate(BUILD_DATE),
    BUILD_DIRTY ? "Built with uncommitted changes" : null,
  ]
    .filter(Boolean)
    .join(" — ");

  const commit = BUILD_COMMIT_URL ? (
    <ExternalLink href={BUILD_COMMIT_URL} className={COMMIT_CLASS}>
      {label}
    </ExternalLink>
  ) : (
    <code className={COMMIT_CLASS}>{label}</code>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={commit} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
