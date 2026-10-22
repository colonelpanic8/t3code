import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";

import ChatView from "./ChatView";
import {
  draftServerThreadHasStarted,
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  resolveThreadDetailRef,
  useEnvironmentThreadRefs,
  useQuietThreadShell,
  useThreadProjection,
} from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveDraftThreadSubscriptionRef,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Plain server threads are unkeyed, so navigating between them reuses one instance as ChatView
 * expects. Rendered by the `_chat` layout rather than by the two leaf routes, since an element
 * only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const groups = useAtomValue(environmentCatalog.groups.stateAtom);
  const setVisible = useAtomCommand(environmentCatalog.groups.setVisible);
  const draftEnvironmentId = useComposerDraftStore((store) =>
    target.kind === "draft" ? store.getDraftSession(target.draftId)?.environmentId : undefined,
  );
  const environmentId =
    target.kind === "server" ? target.threadRef.environmentId : draftEnvironmentId;
  const hiddenGroup =
    environmentId && groups.hiddenEnvironmentIds.has(environmentId)
      ? Object.entries(groups.groups).find(([, group]) =>
          group.environmentIds.includes(environmentId),
        )
      : undefined;
  if (!groups.isReady) return null;
  if (hiddenGroup) {
    const [groupId, group] = hiddenGroup;
    return (
      <SidebarInset className="h-dvh">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This environment is hidden</EmptyTitle>
            <EmptyDescription>Show {group.label} to open this thread.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => void setVisible({ groupId, visible: true })}>
            Show {group.label} for this session
          </Button>
        </Empty>
      </SidebarInset>
    );
  }
  return <VisibleThreadRouteView target={target} />;
}

function VisibleThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const promotedTo = draftSession?.promotedTo ?? null;
  const draftEnvironmentId = draftSession?.environmentId ?? null;
  const draftThreadId = draftSession?.threadId ?? null;
  const draftServerThreadRef =
    draftEnvironmentId === null || draftThreadId === null
      ? null
      : resolveDraftThreadSubscriptionRef({
          environmentId: draftEnvironmentId,
          threadId: draftThreadId,
          promotedTo,
        });
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : draftServerThreadRef;
  const serverThread = useQuietThreadShell(serverThreadRef);
  // Once the bootstrap launch has been accepted (`promotedTo` recorded) the
  // reserved detail stream is an independent promotion signal, so it must not
  // stay gated behind the shell upsert the way an unsent draft's is.
  const draftServerThreadDetail = useThreadProjection(
    target.kind === "draft"
      ? resolveThreadDetailRef(serverThreadRef, {
          shellExists: serverThread !== null,
          waitForShell: promotedTo === null,
        })
      : null,
  );
  const draftServerThreadStarted =
    target.kind === "draft" &&
    draftServerThreadHasStarted({ shell: serverThread, projection: draftServerThreadDetail });
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          serverThreadProjection: draftServerThreadDetail,
          backgroundSubmissionPending,
        })
      : null;

  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (target.kind !== "draft" || !serverThreadRef || !draftServerThreadStarted || promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(serverThreadRef);
  }, [draftServerThreadStarted, promotedTo, serverThreadRef, target.kind]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextChatViewKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {view}
    </SidebarInset>
  );
}
