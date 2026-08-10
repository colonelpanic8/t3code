import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
import { useEnvironmentShellState } from "../../state/shell";
import { useWorkspaceState } from "../../state/workspace";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  deriveNewTaskProjectPickerAction,
  deriveNewTaskProjectPickerEmptyState,
} from "./newTaskPicker";

type NewTaskRouteParams = {
  readonly environmentId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const { projectScopes } = useNewTaskFlow();
  const workspace = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const { getShare, releaseShareReservation } = useIncomingShare();
  const environmentId = (
    Array.isArray(route.params?.environmentId)
      ? route.params.environmentId[0]
      : route.params?.environmentId
  ) as EnvironmentId | undefined;
  const selectedEnvironment =
    workspace.environments.find((environment) => environment.environmentId === environmentId) ??
    null;
  const environmentLabel = selectedEnvironment?.environmentLabel ?? null;
  const environmentShellState = useEnvironmentShellState(environmentId ?? null);
  const environmentProjectScopes = useMemo(
    () =>
      projectScopes.flatMap((scope) => {
        const scopedProjects = scope.projects.filter(
          (project) => project.environmentId === environmentId,
        );
        const representative = scopedProjects[0];
        if (!representative) {
          return [];
        }
        return [
          {
            ...scope,
            representative,
            projects: scopedProjects,
            projectRefs: scope.projectRefs.filter(
              (projectRef) => projectRef.environmentId === environmentId,
            ),
          },
        ];
      }),
    [environmentId, projectScopes],
  );
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? "Choose a project for the image you shared"
        : `Choose a project for the ${incomingShare.attachments.length} images you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const hasEnvironmentShellSnapshot = Option.isSome(environmentShellState.snapshot);
  const projectEmptyState = deriveNewTaskProjectPickerEmptyState({
    environment: selectedEnvironment,
    networkOffline: workspace.state.networkStatus === "offline",
    shellStatus: environmentShellState.status,
    shellError: Option.getOrNull(environmentShellState.error),
    hasShellSnapshot: hasEnvironmentShellSnapshot,
  });
  const emptyStateAction = deriveNewTaskProjectPickerAction({
    hasSelectedEnvironment: selectedEnvironment !== null,
    canAddProject:
      selectedEnvironment?.connectionState === "connected" && hasEnvironmentShellSnapshot,
    loading: projectEmptyState.loading,
  });
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;

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
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      },
    });
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

  const addProject = () =>
    navigation.navigate("NewTaskSheet", {
      screen: "AddProject",
      params: { environmentId },
    });

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
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      },
    });
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={screenTitle}
            subtitle={incomingShareSubtitle ?? environmentLabel}
            onBack={layout.usesSplitView ? () => navigation.goBack() : undefined}
            actions={[
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: addProject,
              },
            ]}
          />
        </>
      ) : (
        <>
          <NativeStackScreenOptions
            options={{
              title: screenTitle,
              unstable_headerSubtitle: incomingShareSubtitle ?? environmentLabel ?? undefined,
            }}
          />
          <NativeHeaderToolbar placement="right">
            {layout.usesSplitView ? (
              <NativeHeaderToolbar.Button
                accessibilityLabel="Close new task"
                icon="xmark"
                onPress={() => navigation.goBack()}
                separateBackground
              />
            ) : null}
            <NativeHeaderToolbar.Button icon="plus" onPress={addProject} separateBackground />
          </NativeHeaderToolbar>
        </>
      )}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 20,
          paddingTop: 8,
        }}
      >
        {environmentProjectScopes.length === 0 ? (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            {projectEmptyState.loading ? <ActivityIndicator color={accentColor} /> : null}
            <Text className="text-center text-lg font-t3-bold text-foreground">
              {projectEmptyState.title}
            </Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              {projectEmptyState.detail}
            </Text>
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
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {environmentProjectScopes.map((scope, scopeIndex) => {
              const hasMultipleProjects = scope.projects.length > 1;
              const expanded = expandedGroupKeys.has(scope.key);
              const singleProject = hasMultipleProjects ? null : scope.projects[0];
              return (
                <View
                  key={scope.key}
                  className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                >
                  <Pressable
                    accessibilityLabel={scope.title}
                    accessibilityRole="button"
                    disabled={singleProject !== null && reservedDestinationProject !== null}
                    onPress={() => {
                      if (singleProject) {
                        void selectProject(singleProject);
                      } else {
                        toggleGroup(scope.key);
                      }
                    }}
                    className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                  >
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={scope.representative.environmentId}
                        faviconPath={scope.representative.faviconPath}
                        size={20}
                        projectTitle={scope.title}
                        workspaceRoot={scope.representative.workspaceRoot}
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-base leading-snug font-t3-bold">{scope.title}</Text>
                      <Text
                        className="text-xs leading-snug text-foreground-muted"
                        ellipsizeMode="middle"
                        numberOfLines={1}
                      >
                        {hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : singleProject?.workspaceRoot}
                      </Text>
                    </View>
                    <SymbolView
                      name={hasMultipleProjects && expanded ? "chevron.down" : "chevron.right"}
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </Pressable>
                  {hasMultipleProjects && expanded
                    ? scope.projects.map((project) => (
                        <Pressable
                          key={scopedProjectKey(project.environmentId, project.id)}
                          accessibilityLabel={project.title}
                          accessibilityRole="button"
                          disabled={reservedDestinationProject !== null}
                          onPress={() => void selectProject(project)}
                          className="flex-row items-center gap-3 border-t border-border-subtle bg-card py-3 pr-4 pl-10"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            faviconPath={project.faviconPath}
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
                            tintColor={chevronColor}
                            type="monochrome"
                          />
                        </Pressable>
                      ))
                    : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
