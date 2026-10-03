import { MaterialListRow } from "../../components/MaterialListRow";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useServerConfigs, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentShellAvailability } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { filterProjectScopes } from "./new-task-project-selection";
import {
  deriveNewTaskProjectPickerAction,
  deriveNewTaskProjectPickerEmptyState,
} from "./newTaskPicker";

type NewTaskRouteParams = {
  readonly environmentId?: string | string[];
  readonly incomingShareId?: string | string[];
};

function NewTaskHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly canAddProject: boolean;
  readonly onAddProject: () => void;
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  return (
    <ScreenHeader
      title={props.title}
      subtitle={props.subtitle ?? undefined}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      options={{ headerBackVisible: !layout.usesSplitView }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={
        props.canAddProject
          ? [
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: props.onAddProject,
              },
            ]
          : []
      }
      search={{
        value: props.searchText,
        onChangeText: props.onSearchTextChange,
        placeholder: "Search projects",
      }}
    />
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const { projectScopes, setProject } = useNewTaskFlow();
  const workspace = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  const environmentId = (
    Array.isArray(route.params?.environmentId)
      ? route.params.environmentId[0]
      : route.params?.environmentId
  ) as EnvironmentId | undefined;
  const selectedEnvironment =
    workspace.environments.find((environment) => environment.environmentId === environmentId) ??
    null;
  const environmentShell = useEnvironmentShellAvailability(environmentId ?? null);
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose a project for the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose a project for the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const canAddProject =
    selectedEnvironment !== null &&
    canCreateProjectInEnvironment(selectedEnvironment.connectionState);
  const projectEmptyState = deriveNewTaskProjectPickerEmptyState({
    environment: selectedEnvironment,
    networkOffline: workspace.state.networkStatus === "offline",
    shellStatus: environmentShell.status,
    shellError: environmentShell.error,
    hasShellSnapshot: environmentShell.hasSnapshot,
  });
  const emptyStateAction = deriveNewTaskProjectPickerAction({
    hasSelectedEnvironment: selectedEnvironment !== null,
    canAddProject: canAddProject && environmentShell.hasSnapshot,
    loading: projectEmptyState.loading,
  });
  const serverConfigs = useServerConfigs();
  const scratchWorkspaceRoot =
    environmentId === undefined
      ? undefined
      : serverConfigs.get(environmentId)?.scratchWorkspaceRoot;
  // Scratch projects are reached through the No project row, never as rows
  // of their own.
  const listScopes = useMemo(
    () =>
      projectScopes.flatMap((scope) => {
        const environmentProjects = scope.projects.filter(
          (project) =>
            project.environmentId === environmentId &&
            !isScratchProject(project, scratchWorkspaceRoot),
        );
        const representative = environmentProjects[0];
        if (!representative) {
          return [];
        }
        return [
          {
            ...scope,
            representative,
            projects: environmentProjects,
            projectRefs: scope.projectRefs.filter(
              (projectRef) => projectRef.environmentId === environmentId,
            ),
          },
        ];
      }),
    [environmentId, projectScopes, scratchWorkspaceRoot],
  );
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, {
    reportFailure: false,
  });
  const canStartScratch =
    canAddProject && scratchWorkspaceRoot !== undefined && reservedDestinationProject === null;
  const scratchStartInFlightRef = useRef(false);

  const addProject = () => navigation.dispatch(StackActions.push("AddProject", { environmentId }));

  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Alert.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    // Changing the project from an open draft goes back through the
    // environment picker, so return to that draft instead of stacking another.
    const routes = navigation.getState()?.routes ?? [];
    if (routes.some((stackRoute) => stackRoute.name === "NewTaskDraft")) {
      setProject(project);
      navigation.dispatch(StackActions.popTo("NewTaskDraft"));
      return;
    }

    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      }),
    );
  }

  function toggleGroup(groupKey: string): void {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  async function startScratch(): Promise<void> {
    if (!environmentId || !canStartScratch || scratchStartInFlightRef.current) return;
    scratchStartInFlightRef.current = true;
    try {
      const result = await ensureScratch({ environmentId, input: {} });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not start without a project",
          error instanceof Error
            ? error.message
            : "The folder for threads without a project could not be created.",
        );
        return;
      }
      const project = await waitForProject({ environmentId, projectId: result.value.projectId });
      if (project === null) {
        Alert.alert(
          "Could not start without a project",
          "It has not reached this device yet. Pick No project from the list once it appears.",
        );
        return;
      }
      await selectProject(project);
    } finally {
      scratchStartInFlightRef.current = false;
    }
  }

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Returning from the reserved draft is a fresh resume attempt. Keeping
      // this latch set would leave every project row disabled with no route.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
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

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={screenTitle}
        subtitle={incomingShareSubtitle ?? selectedEnvironment?.environmentLabel ?? null}
        canAddProject={canAddProject}
        onAddProject={addProject}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {canStartScratch && listScopes.length > 0 ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <MaterialListRow
                  className="bg-grouped-card"
                  title="No project"
                  subtitle="Start a task without a project"
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="No project"
                  onPress={() => void startScratch()}
                  className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">No project</Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      Start a task without a project
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {listScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {projectEmptyState.loading ? (
                <ActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  {emptyStateAction === "add-environment" ? (
                    <MaterialButton
                      label="Add environment"
                      tone="primary"
                      onPress={() => navigation.navigate("ConnectionsNew")}
                    />
                  ) : emptyStateAction === "add-project" ? (
                    <MaterialButton label="Add new project" tone="primary" onPress={addProject} />
                  ) : null}
                  {canStartScratch ? (
                    <MaterialButton
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  {emptyStateAction === "add-environment" ? (
                    <Pressable
                      className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                      onPress={() => navigation.navigate("ConnectionsNew")}
                    >
                      <Text className="text-sm font-t3-bold text-primary-foreground">
                        Add environment
                      </Text>
                    </Pressable>
                  ) : emptyStateAction === "add-project" ? (
                    <Pressable
                      className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                      onPress={addProject}
                    >
                      <Text className="text-sm font-t3-bold text-primary-foreground">
                        Add new project
                      </Text>
                    </Pressable>
                  ) : null}
                  {canStartScratch ? (
                    <Pressable
                      className="rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
                      onPress={() => void startScratch()}
                    >
                      <Text className="text-sm font-t3-bold text-foreground">
                        Start without a project
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                No matching projects
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Try a different project name or workspace path.
              </Text>
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
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const expanded = hasMultipleProjects && expandedGroupKeys.has(scope.key);
                const singleProject = hasMultipleProjects ? null : scope.representative;
                const onPressScope = () => {
                  if (singleProject) {
                    void selectProject(singleProject);
                  } else {
                    toggleGroup(scope.key);
                  }
                };
                const subtitle = hasMultipleProjects
                  ? `${scope.projects.length} workspaces`
                  : scope.representative.workspaceRoot;
                const workspaceRows = expanded
                  ? scope.projects.map((project) =>
                      Platform.OS === "android" ? (
                        <MaterialListRow
                          className="bg-grouped-card pl-10"
                          key={scopedProjectKey(project.environmentId, project.id)}
                          title={project.title}
                          subtitle={project.workspaceRoot}
                          disabled={reservedDestinationProject !== null}
                          onPress={() => void selectProject(project)}
                          leading={
                            <ProjectFavicon
                              environmentId={project.environmentId}
                              faviconPath={project.faviconPath}
                              projectIcon={project.projectIcon}
                              size={20}
                              projectTitle={project.title}
                              workspaceRoot={project.workspaceRoot}
                            />
                          }
                        />
                      ) : (
                        <Pressable
                          key={scopedProjectKey(project.environmentId, project.id)}
                          accessibilityRole="button"
                          accessibilityLabel={project.title}
                          disabled={reservedDestinationProject !== null}
                          onPress={() => void selectProject(project)}
                          className="flex-row items-center gap-3 border-t border-border-subtle bg-grouped-card py-3 pr-4 pl-10"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            faviconPath={project.faviconPath}
                            projectIcon={project.projectIcon}
                            size={18}
                            projectTitle={project.title}
                            workspaceRoot={project.workspaceRoot}
                          />
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm font-t3-bold text-foreground">
                              {project.title}
                            </Text>
                            <Text
                              className="text-xs text-foreground-muted"
                              ellipsizeMode="middle"
                              numberOfLines={1}
                            >
                              {project.workspaceRoot}
                            </Text>
                          </View>
                          <SymbolView
                            name="chevron.right"
                            size={14}
                            tintColorClassName="accent-chevron"
                            type="monochrome"
                          />
                        </Pressable>
                      ),
                    )
                  : null;
                if (Platform.OS === "android") {
                  return (
                    <View key={scope.key}>
                      <MaterialListRow
                        className="bg-grouped-card"
                        title={scope.title}
                        subtitle={subtitle}
                        disabled={singleProject !== null && reservedDestinationProject !== null}
                        onPress={onPressScope}
                        leading={
                          <ProjectFavicon
                            environmentId={scope.representative.environmentId}
                            faviconPath={scope.representative.faviconPath}
                            projectIcon={scope.representative.projectIcon}
                            size={24}
                            projectTitle={scope.title}
                            workspaceRoot={scope.representative.workspaceRoot}
                          />
                        }
                      />
                      {workspaceRows}
                    </View>
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      disabled={singleProject !== null && reservedDestinationProject !== null}
                      onPress={onPressScope}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {subtitle}
                        </Text>
                      </View>
                      <SymbolView
                        name={expanded ? "chevron.down" : "chevron.right"}
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                    {workspaceRows}
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
