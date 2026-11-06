import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupCoordinatorInbox,
  type CoordinatorChoice,
} from "@t3tools/client-runtime/state/coordinator-inbox";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CoordinatorInboxItem,
  CoordinatorInboxItemKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InboxIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  coordinatorThreadRef,
  useCoordinatorChoices,
  useDefaultCoordinator,
} from "../../state/coordinators";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FINISHED_EXPANDED_KEY = "t3code:sidebar:coordinator-finished-expanded";
const EMPTY_ITEMS: ReadonlyArray<CoordinatorInboxItem> = [];

const KIND_PRESENTATION: Record<
  CoordinatorInboxItemKind,
  { readonly label: string; readonly icon: LucideIcon; readonly tone: string }
> = {
  question: { label: "Question", icon: MessageCircleQuestionIcon, tone: "text-info-foreground" },
  approval: { label: "Approval", icon: ShieldAlertIcon, tone: "text-warning" },
  failed: { label: "Failed", icon: CircleAlertIcon, tone: "text-destructive-foreground" },
  unread: { label: "Finished", icon: CircleCheckIcon, tone: "text-success-foreground" },
  note: { label: "Note", icon: StickyNoteIcon, tone: "text-sidebar-muted-foreground" },
};

export function SidebarCoordinatorInbox(props: {
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const choice = useDefaultCoordinator();
  const hasChoices = useCoordinatorChoices().length > 0;
  const navigate = useNavigate();
  if (choice === null) {
    return hasChoices ? (
      <button
        type="button"
        className="mx-0.5 mb-1 flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={() => void navigate({ to: "/settings/general", hash: "default-coordinator" })}
      >
        <InboxIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">Choose a coordinator</span>
      </button>
    ) : null;
  }
  return (
    <CoordinatorInboxGroup
      key={`${choice.environmentId}:${choice.coordinator.id}`}
      choice={choice}
      onOpenThread={props.onOpenThread}
    />
  );
}

function CoordinatorInboxGroup(props: {
  readonly choice: CoordinatorChoice;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const { environmentId, coordinator } = props.choice;
  const threadRef = coordinatorThreadRef(props.choice);
  const inbox = useEnvironmentQuery(
    serverEnvironment.coordinatorInboxLive({
      environmentId,
      input: { coordinatorId: coordinator.id },
    }),
  );
  const { needsYou, finished } = groupCoordinatorInbox(inbox.data?.items ?? EMPTY_ITEMS);
  const unreachable = (inbox.data?.sources ?? []).filter(
    (source) => source.status === "unreachable",
  );
  const connectedIds = useConnectedEnvironmentIds();
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const [finishedExpanded, setFinishedExpanded] = useLocalStorage(
    FINISHED_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const canWake = useAtomValue(serverEnvironment.wakeCoordinator.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    serverEnvironment.dismissCoordinatorInboxItem.permissionAtom(environmentId),
  );
  const wake = useAtomCommand(serverEnvironment.wakeCoordinator, { label: "coordinator wake" });
  const dismiss = useAtomCommand(serverEnvironment.dismissCoordinatorInboxItem, {
    label: "coordinator inbox dismiss",
  });
  const [waking, setWaking] = useState(false);

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      }),
    );
  };

  const startSession = async () => {
    if (waking) return;
    setWaking(true);
    const result = await wake({ environmentId, input: { coordinatorId: coordinator.id } });
    setWaking(false);
    if (result._tag === "Failure") {
      reportFailure("Could not start a coordinator session", result);
      return;
    }
    if (threadRef !== null) props.onOpenThread(threadRef);
  };

  const dismissItem = async (item: CoordinatorInboxItem) => {
    const result = await dismiss({
      environmentId,
      input: { coordinatorId: coordinator.id, itemId: item.id },
    });
    if (result._tag === "Failure") reportFailure("Could not dismiss note", result);
  };

  const renderItem = (item: CoordinatorInboxItem) => (
    <CoordinatorInboxRow
      key={item.id}
      item={item}
      nowMs={nowMs}
      reachable={item.thread !== null && connectedIds.includes(item.thread.environmentId)}
      onOpen={() => {
        if (item.thread !== null) {
          props.onOpenThread(scopeThreadRef(item.thread.environmentId, item.thread.threadId));
        }
      }}
      onDismiss={item.kind === "note" && canDismiss ? () => void dismissItem(item) : null}
    />
  );

  const headerTitle = (
    <>
      <InboxIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{coordinator.name}</span>
      {needsYou.length > 0 ? (
        <span className="shrink-0 font-normal tabular-nums">{needsYou.length}</span>
      ) : null}
    </>
  );
  const headerClassName =
    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-muted-foreground";

  return (
    <section aria-label={`${coordinator.name} inbox`} className="mx-0.5 mb-2 flex flex-col gap-px">
      <div className="flex items-center gap-1 pe-1">
        {threadRef !== null ? (
          <button
            type="button"
            className={cn(
              headerClassName,
              "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
            onClick={() => props.onOpenThread(threadRef)}
          >
            {headerTitle}
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<div className={headerClassName}>{headerTitle}</div>} />
            <TooltipPopup side="right">
              {coordinator.error ?? "The coordinator's thread is still being set up."}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label="New coordinator session"
                disabled={!canWake || waking}
                onClick={() => void startSession()}
              >
                <RotateCcwIcon />
              </Button>
            }
          />
          <TooltipPopup side="right">New session</TooltipPopup>
        </Tooltip>
      </div>
      {needsYou.length > 0 ? (
        <ul className="flex flex-col gap-px">{needsYou.map(renderItem)}</ul>
      ) : null}
      {finished.length > 0 ? (
        <>
          <CollapsibleSectionHeader
            expanded={finishedExpanded}
            onClick={() => setFinishedExpanded(!finishedExpanded)}
            accessory={<span className="font-normal tabular-nums">{finished.length}</span>}
          >
            Finished
          </CollapsibleSectionHeader>
          {finishedExpanded ? (
            <ul className="flex flex-col gap-px">{finished.map(renderItem)}</ul>
          ) : null}
        </>
      ) : null}
      {inbox.error !== null ? (
        <InboxStatusLine label="Inbox unavailable" detail={inbox.error} />
      ) : unreachable.length > 0 ? (
        <InboxStatusLine
          label={`Can't reach ${unreachable.map((source) => source.label).join(", ")}`}
          detail={unreachable
            .map((source) => (source.error ? `${source.label}: ${source.error}` : source.label))
            .join("\n")}
        />
      ) : null}
    </section>
  );
}

function InboxStatusLine(props: { readonly label: string; readonly detail: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <p className="truncate px-2 text-xs text-sidebar-muted-foreground">{props.label}</p>
        }
      />
      <TooltipPopup side="right" className="whitespace-pre-line">
        {props.detail}
      </TooltipPopup>
    </Tooltip>
  );
}

function CoordinatorInboxRow(props: {
  readonly item: CoordinatorInboxItem;
  readonly nowMs: number;
  readonly reachable: boolean;
  readonly onOpen: () => void;
  readonly onDismiss: (() => void) | null;
}) {
  const { item } = props;
  const kind = KIND_PRESENTATION[item.kind];
  const Icon = kind.icon;
  const meta = [kind.label, item.environmentLabel, item.detail].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", kind.tone)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-sidebar-foreground">{item.title}</span>
        <span className="block truncate text-xs text-sidebar-muted-foreground">{meta}</span>
      </span>
      <span className="shrink-0 text-xs text-sidebar-muted-foreground tabular-nums">
        {formatRelativeTimeLabel(item.since, props.nowMs)}
      </span>
    </>
  );
  const rowClassName = "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1 text-left";
  return (
    <li className="flex items-start gap-0.5">
      {item.thread === null ? (
        <div className={rowClassName}>{body}</div>
      ) : props.reachable ? (
        <button
          type="button"
          className={cn(rowClassName, "hover:bg-sidebar-row-hover")}
          onClick={props.onOpen}
        >
          {body}
        </button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button type="button" aria-disabled className={cn(rowClassName, "opacity-64")}>
                {body}
              </button>
            }
          />
          <TooltipPopup side="right">
            {`Connect to ${item.environmentLabel ?? "its environment"} to open this thread.`}
          </TooltipPopup>
        </Tooltip>
      )}
      {props.onDismiss !== null ? (
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label={`Dismiss ${item.title}`}
          onClick={props.onDismiss}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}
