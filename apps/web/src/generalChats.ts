import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ProjectId as ProjectIdSchema } from "@t3tools/contracts";

import type { Project } from "./types";

export const GENERAL_CHATS_PROJECT_ID = ProjectIdSchema.make("t3code-general-chats");
export const GENERAL_CHATS_PROJECT_TITLE = "Chats";
export const GENERAL_CHATS_WORKSPACE_ROOT = "~/.t3/chats";

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
