import { type MouseEvent, useCallback } from "react";

import {
  BUILD_COMMIT,
  BUILD_COMMIT_SHORT,
  BUILD_COMMIT_URL,
  BUILD_DATE,
  BUILD_DIRTY,
  BUILD_REPO_LABEL,
} from "../../buildProvenance";
import { formatCommitDate } from "../../buildProvenance.logic";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

const COMMIT_CLASS = "font-mono text-[11px] text-muted-foreground";

/**
 * The commit this build came from, linked to it on the host it was built from.
 *
 * Renders nothing when the build carries no provenance, which is the normal
 * state for a build made outside a checkout without `T3CODE_BUILD_*` set.
 */
export function BuildCommitLink() {
  const handleClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!BUILD_COMMIT_URL) return;
    event.preventDefault();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }

    void api.shell.openExternal(BUILD_COMMIT_URL).catch((error: unknown) => {
      console.error(error);
      toastManager.add({
        type: "error",
        title: "Unable to open the commit link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

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
    <a
      href={BUILD_COMMIT_URL}
      onClick={handleClick}
      className={cn(
        COMMIT_CLASS,
        "underline decoration-dotted underline-offset-2 hover:text-foreground",
      )}
    >
      {label}
    </a>
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
