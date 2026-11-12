import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  groupCoordinatorInbox,
  type CoordinatorChoice,
} from "@t3tools/client-runtime/state/coordinator-inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { CoordinatorInboxItem, CoordinatorInboxItemKind } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useCoordinatorChoices } from "../../state/coordinators";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const MAX_CONTENT_WIDTH = 720;

const KINDS: Readonly<
  Record<CoordinatorInboxItemKind, { readonly label: string; readonly icon: AppSymbolName }>
> = {
  question: { label: "Question", icon: "questionmark.bubble" },
  approval: { label: "Approval", icon: "exclamationmark.shield" },
  failed: { label: "Failed", icon: "exclamationmark.triangle" },
  unread: { label: "Finished", icon: "checkmark.circle" },
  note: { label: "Note", icon: "text.bubble" },
};

function useEnvironmentLabel() {
  const environments = useWorkspaceEnvironments();
  return (environmentId: string) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? environmentId;
}

export function InboxScreen() {
  const insets = useSafeAreaInsets();
  const { choices, resolved } = useCoordinatorChoices();
  return (
    <SettingsScreen title="Inbox" workspaceRoot>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="w-full gap-6 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
          {resolved ? (
            <CoordinatorInbox
              key={`${resolved.environmentId}:${resolved.coordinator.id}`}
              choice={resolved}
            />
          ) : choices.length > 0 ? (
            <CoordinatorChooser choices={choices} />
          ) : (
            <EmptyState
              variant="plain"
              title="No coordinators"
              detail="Add one to the coordinators section of an environment's settings.json. Its inbox collects questions, approvals, failures and finished work from every linked environment."
            />
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CoordinatorChooser(props: { readonly choices: ReadonlyArray<CoordinatorChoice> }) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const environmentLabel = useEnvironmentLabel();
  return (
    <ListSection title="Choose a coordinator" footer="Change it later in Settings › General.">
      {props.choices.map((choice, index) => (
        <ListChoiceRow
          key={`${choice.environmentId}:${choice.coordinator.id}`}
          label={choice.coordinator.name}
          description={environmentLabel(choice.environmentId)}
          selected={false}
          separated={index > 0}
          onPress={() =>
            savePreferences({
              defaultCoordinator: {
                environmentId: choice.environmentId,
                coordinatorId: choice.coordinator.id,
              },
            })
          }
        />
      ))}
    </ListSection>
  );
}

function CoordinatorInbox(props: { readonly choice: CoordinatorChoice }) {
  const { environmentId, coordinator } = props.choice;
  const inbox = useEnvironmentQuery(
    serverEnvironment.coordinatorInboxLive({
      environmentId,
      input: { coordinatorId: coordinator.id },
    }),
  );
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const environmentLabel = useEnvironmentLabel();
  const selectDetail = useSelectWorkspaceDetail();
  const nowMs = useNowMinuteMs();
  const canWake = useAtomValue(serverEnvironment.wakeCoordinator.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    serverEnvironment.dismissCoordinatorInboxItem.permissionAtom(environmentId),
  );
  const wake = useAtomCommand(serverEnvironment.wakeCoordinator, {
    label: "coordinator wake",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(serverEnvironment.dismissCoordinatorInboxItem, {
    label: "coordinator inbox dismiss",
    reportFailure: false,
  });
  const [waking, setWaking] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const groups = groupCoordinatorInbox(inbox.data?.items ?? []);
  const unreachable = (inbox.data?.sources ?? []).filter(
    (source) => source.status === "unreachable",
  );

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };
  const openThread = (thread: { readonly environmentId: string; readonly threadId: string }) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: thread.environmentId, threadId: thread.threadId },
    });
  const startSession = async () => {
    setWaking(true);
    const result = await wake({ environmentId, input: { coordinatorId: coordinator.id } });
    setWaking(false);
    failure("Could not start a new session", result);
  };
  const renderItem = (item: CoordinatorInboxItem, index: number) => {
    const thread = item.thread;
    const reachable = thread !== null && connected.includes(thread.environmentId);
    return (
      <InboxItemRow
        key={item.id}
        item={item}
        separated={index > 0}
        nowMs={nowMs}
        hint={
          thread !== null && !reachable
            ? `Connect to ${item.environmentLabel ?? "its environment"} to open`
            : null
        }
        onOpen={thread !== null && reachable ? () => openThread(thread) : undefined}
        onDismiss={
          item.kind === "note" && canDismiss
            ? async () =>
                failure(
                  "Could not dismiss note",
                  await dismiss({
                    environmentId,
                    input: { coordinatorId: coordinator.id, itemId: item.id },
                  }),
                )
            : undefined
        }
      />
    );
  };

  return (
    <>
      <ListSection title="Coordinator">
        <ListRow
          icon="robot"
          label={coordinator.name}
          description={coordinator.error ?? environmentLabel(environmentId)}
          disabled={coordinator.threadId === null}
          onPress={() => {
            if (coordinator.threadId !== null)
              openThread({ environmentId, threadId: coordinator.threadId });
          }}
        />
        <View className="border-t border-border-subtle">
          <ListActionRow
            icon="arrow.clockwise"
            label="New session"
            description="Same thread, fresh context, briefed on this inbox."
            disabled={!canWake || coordinator.threadId === null}
            loading={waking}
            onPress={() => void startSession()}
          />
        </View>
      </ListSection>
      {inbox.error ? (
        <Text className="px-2 text-base text-danger-foreground">{inbox.error}</Text>
      ) : !inbox.data ? (
        <Text className="px-2 text-base text-foreground-muted">Loading inbox…</Text>
      ) : (
        <>
          <ListSection title={`Needs you · ${groups.needsYou.length}`}>
            {groups.needsYou.length > 0 ? (
              groups.needsYou.map(renderItem)
            ) : (
              <Text className="p-4 text-base text-foreground-muted">Nothing needs you.</Text>
            )}
          </ListSection>
          {groups.finished.length > 0 ? (
            <ListSection
              title={`Finished · ${groups.finished.length}`}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: finishedOpen }}
                  onPress={() => setFinishedOpen((open) => !open)}
                  className="px-2 py-1 active:opacity-70"
                >
                  <Text textRole="footnote" className="font-t3-medium text-primary-text">
                    {finishedOpen ? "Hide" : "Show"}
                  </Text>
                </Pressable>
              }
            >
              {finishedOpen ? groups.finished.map(renderItem) : null}
            </ListSection>
          ) : null}
          {unreachable.length > 0 ? (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              Unreachable: {unreachable.map((source) => source.label).join(", ")}
            </Text>
          ) : null}
        </>
      )}
    </>
  );
}

function InboxItemRow(props: {
  readonly item: CoordinatorInboxItem;
  readonly separated: boolean;
  readonly nowMs: number;
  readonly hint: string | null;
  readonly onOpen: (() => void) | undefined;
  readonly onDismiss: (() => void) | undefined;
}) {
  const { item } = props;
  const kind = KINDS[item.kind];
  const meta = [kind.label, item.environmentLabel, relativeTime(item.since, props.nowMs)]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      className={cn(
        "flex-row items-start gap-1 bg-grouped-card px-4 py-3",
        props.separated && "border-t border-border-subtle",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${kind.label}: ${item.title}`}
        accessibilityHint={props.hint ?? undefined}
        accessibilityState={{ disabled: props.onOpen === undefined }}
        disabled={props.onOpen === undefined}
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-start gap-3 active:opacity-70"
      >
        <View className="size-6 items-center justify-center pt-0.5">
          <SymbolView name={kind.icon} size={20} tintColorClassName="accent-icon" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={2}>
            {item.title}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {meta}
          </Text>
          {item.detail ? (
            <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
              {item.detail}
            </Text>
          ) : null}
          {props.hint ? (
            <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
              {props.hint}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {props.onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${item.title}`}
          onPress={props.onDismiss}
          className="h-11 w-11 items-center justify-center active:opacity-70"
        >
          <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
    </View>
  );
}
