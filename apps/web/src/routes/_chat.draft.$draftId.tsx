import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import {
  draftServerThreadHasStarted,
  resolveDraftPromotionNavigationTarget,
} from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams, resolveDraftThreadSubscriptionRef } from "../threadRoutes";
import { resolveThreadDetailRef, useThreadProjection, useThreadShell } from "../state/entities";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  // The draft reserves its server thread ref at creation, so promotion can
  // observe that ref directly instead of waiting for the shell thread list to
  // publish the bootstrapped thread.
  const promotedTo = draftSession?.promotedTo ?? null;
  const draftEnvironmentId = draftSession?.environmentId ?? null;
  const draftThreadId = draftSession?.threadId ?? null;
  const serverThreadRef = useMemo(
    () =>
      draftEnvironmentId === null || draftThreadId === null
        ? null
        : resolveDraftThreadSubscriptionRef({
            environmentId: draftEnvironmentId,
            threadId: draftThreadId,
            promotedTo,
          }),
    [draftEnvironmentId, draftThreadId, promotedTo],
  );
  const serverThread = useThreadShell(serverThreadRef);
  // Once the bootstrap launch has been accepted (`promotedTo` recorded) the
  // reserved detail stream is an independent promotion signal, so it must not
  // stay gated behind the shell upsert the way an unsent draft's is.
  const serverThreadDetailRef = resolveThreadDetailRef(serverThreadRef, {
    shellExists: serverThread !== null,
    waitForShell: promotedTo === null,
  });
  const serverThreadDetail = useThreadProjection(serverThreadDetailRef);
  const serverThreadStarted = draftServerThreadHasStarted({
    shell: serverThread,
    projection: serverThreadDetail,
  });
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThread,
    serverThreadProjection: serverThreadDetail,
    backgroundSubmissionPending,
  });

  useEffect(() => {
    if (!serverThreadRef || !serverThreadStarted || promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(serverThreadRef);
  }, [promotedTo, serverThreadRef, serverThreadStarted]);

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
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
