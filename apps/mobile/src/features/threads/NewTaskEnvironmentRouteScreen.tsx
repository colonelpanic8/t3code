import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import {
  buildNewTaskEnvironmentItems,
  deriveNewTaskPickerEmptyState,
  deriveNewTaskProjectPickerAction,
} from "./newTaskPicker";

type NewTaskEnvironmentRouteParams = {
  readonly incomingShareId?: string | string[];
};

export function NewTaskEnvironmentRouteScreen({
  route,
}: StaticScreenProps<NewTaskEnvironmentRouteParams | undefined>) {
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const workspace = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const { getShare } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const environmentItems = useMemo(
    () =>
      buildNewTaskEnvironmentItems({
        environments: workspace.environments,
        projects: projects.filter(
          (project) =>
            !isScratchProject(
              project,
              serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot,
            ),
        ),
        threads,
        // Environments that can start a task without a project are useful
        // destinations even before they have any projects.
        scratchEnvironmentIds: new Set(
          workspace.environments
            .filter(
              (environment) =>
                availableScratchWorkspaceRoot(
                  environment.connectionState,
                  serverConfigs.get(environment.environmentId),
                ) !== null,
            )
            .map((environment) => environment.environmentId),
        ),
      }),
    [projects, serverConfigs, threads, workspace.environments],
  );
  const emptyState = deriveNewTaskPickerEmptyState(workspace.state);
  const emptyStateAction = deriveNewTaskProjectPickerAction({
    // This is the environment picker: saved connections are choices, not a selection.
    hasSelectedEnvironment: false,
    canAddProject: workspace.state.hasReadyEnvironment && workspace.state.hasLoadedShellSnapshot,
    loading: emptyState.loading,
  });
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose where to run what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose where to run the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose where to run the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose environment";

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (
      resumedDestinationKeyRef.current === destinationKey ||
      reservedDestinationProject === null
    ) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      }),
    );
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  const addProject = () => navigation.dispatch(StackActions.push("AddProject"));
  const chooseEnvironment = (environmentId: (typeof environmentItems)[number]["environmentId"]) =>
    navigation.dispatch(
      StackActions.push("NewTaskProject", {
        environmentId,
        incomingShareId: incomingShare?.id,
      }),
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title={screenTitle}
        subtitle={incomingShareSubtitle ?? undefined}
        sidebar={false}
        backInSplitView={{
          accessibilityLabel: "Go back",
          icon: "chevron.left",
        }}
        options={{ headerBackVisible: !layout.usesSplitView }}
        hideBottomBorder
        onBack={() => navigation.goBack()}
        actions={
          workspace.state.hasReadyEnvironment
            ? [
                {
                  accessibilityLabel: "Add project",
                  icon: "plus",
                  onPress: addProject,
                },
              ]
            : []
        }
      />

      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && environmentItems.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {environmentItems.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {emptyState.loading ? <ActivityIndicator colorClassName="accent-icon-muted" /> : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {emptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {emptyState.detail}
              </Text>
              {emptyStateAction === "none" ? null : Platform.OS === "android" ? (
                <MaterialButton
                  label={emptyStateAction === "add-project" ? "Add new project" : "Add environment"}
                  tone="primary"
                  onPress={() =>
                    emptyStateAction === "add-project"
                      ? addProject()
                      : navigation.navigate("ConnectionsNew")
                  }
                />
              ) : (
                <Pressable
                  className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                  onPress={() =>
                    emptyStateAction === "add-project"
                      ? addProject()
                      : navigation.navigate("ConnectionsNew")
                  }
                >
                  <Text className="text-sm font-t3-bold text-primary-foreground">
                    {emptyStateAction === "add-project" ? "Add new project" : "Add environment"}
                  </Text>
                </Pressable>
              )}
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {environmentItems.map((item, index) => {
                const projectCountLabel = `${item.projectCount} ${
                  item.projectCount === 1 ? "project" : "projects"
                }`;
                if (Platform.OS === "android") {
                  return (
                    <MaterialListRow
                      className="bg-grouped-card"
                      key={item.environmentId}
                      title={item.environmentLabel}
                      subtitle={projectCountLabel}
                      disabled={reservedDestinationProject !== null}
                      onPress={() => chooseEnvironment(item.environmentId)}
                      leading={
                        <SymbolView
                          name="desktopcomputer"
                          size={22}
                          tintColorClassName="accent-icon-muted"
                          type="monochrome"
                        />
                      }
                    />
                  );
                }
                return (
                  <Pressable
                    key={item.environmentId}
                    accessibilityLabel={`${item.environmentLabel}, ${projectCountLabel}`}
                    accessibilityRole="button"
                    disabled={reservedDestinationProject !== null}
                    onPress={() => chooseEnvironment(item.environmentId)}
                    className={cn(
                      "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                      index > 0 && "border-t border-border-subtle",
                    )}
                  >
                    <View className="h-7 w-7 items-center justify-center">
                      <SymbolView
                        name="desktopcomputer"
                        size={20}
                        tintColorClassName="accent-icon-muted"
                        type="monochrome"
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-base font-t3-bold leading-snug">
                        {item.environmentLabel}
                      </Text>
                      <Text className="text-xs leading-snug text-foreground-muted">
                        {projectCountLabel}
                      </Text>
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
