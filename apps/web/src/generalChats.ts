import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ProjectId as ProjectIdSchema } from "@t3tools/contracts";

import type { DraftThreadEnvMode } from "./composerDraftStore";
import type { Project } from "./types";

export const GENERAL_CHATS_PROJECT_ID = ProjectIdSchema.make("t3code-general-chats");
export const GENERAL_CHATS_PROJECT_TITLE = "Chats";
export const GENERAL_CHATS_WORKSPACE_ROOT = "~/.t3/chats";
export const GENERAL_CHAT_NEW_THREAD_OPTIONS = {
  branch: null,
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
} as const;

export interface GeneralChatNewThreadOptions {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly envMode?: DraftThreadEnvMode;
  readonly startFromOrigin?: boolean;
}

export function isGeneralChatsProject(
  project: Pick<Project, "id">,
): project is Pick<Project, "id"> & { readonly id: ProjectId } {
  return project.id === GENERAL_CHATS_PROJECT_ID;
}

export function findGeneralChatsProject(
  projects: ReadonlyArray<Project>,
  environmentId: EnvironmentId | null,
): Project | null {
  if (environmentId === null) {
    return null;
  }

  return (
    projects.find(
      (project) => project.environmentId === environmentId && isGeneralChatsProject(project),
    ) ?? null
  );
}

export function excludeGeneralChatsProject(projects: ReadonlyArray<Project>): Project[] {
  return projects.filter((project) => !isGeneralChatsProject(project));
}

export function getGeneralChatNewThreadOptions(projectId: ProjectId) {
  return projectId === GENERAL_CHATS_PROJECT_ID ? GENERAL_CHAT_NEW_THREAD_OPTIONS : undefined;
}

export function resolveGeneralChatNewThreadOptions(
  projectId: ProjectId,
  options?: GeneralChatNewThreadOptions,
): GeneralChatNewThreadOptions | undefined {
  const generalChatOptions = getGeneralChatNewThreadOptions(projectId);
  return generalChatOptions ? { ...options, ...generalChatOptions } : options;
}

export function isGeneralChatsProjectAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return (
    candidate._tag === "OrchestrationCommandInvariantError" &&
    candidate.commandType === "project.create" &&
    candidate.detail ===
      `Project '${GENERAL_CHATS_PROJECT_ID}' already exists and cannot be created twice.`
  );
}
