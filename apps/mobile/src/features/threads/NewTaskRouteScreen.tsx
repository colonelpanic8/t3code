import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useThreadShells } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentShellState } from "../../state/shell";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import {
  buildNewTaskProjectItems,
  deriveNewTaskProjectPickerAction,
  deriveNewTaskProjectPickerEmptyState,
} from "./newTaskPicker";
import * as Option from "effect/Option";

type NewTaskRouteParams = {
  readonly environmentId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const threads = useThreadShells();
  const workspace = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
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
  const items = useMemo(
    () =>
      environmentId
        ? buildNewTaskProjectItems({
            environmentId,
            projects,
            threads,
          })
        : [],
    [environmentId, projects, threads],
  );
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

  async function selectProject(item: (typeof items)[number]): Promise<void> {
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
        environmentId: item.environmentId,
        projectId: item.id,
        title: item.title,
        incomingShareId: incomingShare?.id,
      },
    });
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
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: () =>
                  navigation.navigate("NewTaskSheet", {
                    screen: "AddProject",
                    params: { environmentId },
                  }),
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
            <NativeHeaderToolbar.Button
              icon="plus"
              onPress={() =>
                navigation.navigate("NewTaskSheet", {
                  screen: "AddProject",
                  params: { environmentId },
                })
              }
              separateBackground
            />
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
        {items.length === 0 ? (
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
                onPress={() =>
                  navigation.navigate("NewTaskSheet", {
                    screen: "AddProject",
                    params: { environmentId },
                  })
                }
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add new project
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {items.map((item, index) => {
              const isFirst = index === 0;
              const isLast = index === items.length - 1;

              return (
                <Pressable
                  key={item.key}
                  accessibilityLabel={item.title}
                  accessibilityRole="button"
                  disabled={reservedDestinationProject !== null}
                  onPress={() => void selectProject(item)}
                  className={cn(
                    "bg-card px-4 py-3.5",
                    !isFirst && "border-t border-border-subtle",
                    isFirst && "rounded-t-[24px]",
                    isLast && "rounded-b-[24px]",
                  )}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={item.environmentId}
                        size={20}
                        projectTitle={item.title}
                        workspaceRoot={item.workspaceRoot}
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-base leading-snug font-t3-bold">{item.title}</Text>
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
