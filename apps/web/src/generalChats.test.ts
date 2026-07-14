import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "./types";
import {
  excludeGeneralChatsProject,
  findGeneralChatsProject,
  GENERAL_CHATS_PROJECT_ID,
  isGeneralChatsProject,
} from "./generalChats";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("remote");

function makeProject(input: {
  readonly id: ProjectId;
  readonly environmentId?: EnvironmentId;
  readonly title?: string;
}): Project {
  return {
    id: input.id,
    environmentId: input.environmentId ?? LOCAL_ENVIRONMENT_ID,
    title: input.title ?? "Project",
    workspaceRoot: "/workspace",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("general chats project", () => {
  it("recognizes the reserved project id", () => {
    expect(isGeneralChatsProject(makeProject({ id: GENERAL_CHATS_PROJECT_ID }))).toBe(true);
    expect(isGeneralChatsProject(makeProject({ id: ProjectId.make("regular") }))).toBe(false);
  });

  it("finds chats only in the requested environment", () => {
    const localChats = makeProject({ id: GENERAL_CHATS_PROJECT_ID });
    const remoteChats = makeProject({
      id: GENERAL_CHATS_PROJECT_ID,
      environmentId: REMOTE_ENVIRONMENT_ID,
    });

    expect(findGeneralChatsProject([remoteChats, localChats], LOCAL_ENVIRONMENT_ID)).toBe(
      localChats,
    );
    expect(findGeneralChatsProject([localChats], REMOTE_ENVIRONMENT_ID)).toBeNull();
    expect(findGeneralChatsProject([localChats], null)).toBeNull();
  });

  it("keeps the reserved project out of normal project lists", () => {
    const regularProject = makeProject({ id: ProjectId.make("regular") });
    const chatsProject = makeProject({ id: GENERAL_CHATS_PROJECT_ID });

    expect(excludeGeneralChatsProject([chatsProject, regularProject])).toEqual([regularProject]);
  });
});
