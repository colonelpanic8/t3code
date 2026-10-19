import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildAssistantCatalog } from "./assistant-catalog";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");

function project(environmentId: EnvironmentId, id: string, title: string, updatedAt: string) {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/src/${id}`,
    repositoryIdentity:
      id === "web" ? { canonicalKey: "github.com/acme/web", owner: "acme", name: "web" } : null,
    updatedAt,
  } as unknown as EnvironmentProject;
}

function thread(environmentId: EnvironmentId, id: string, updatedAt: string, extra = {}) {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("web"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    title: id,
    updatedAt,
    ...extra,
  });
}

describe("buildAssistantCatalog", () => {
  const catalog = buildAssistantCatalog({
    now: new Date("2026-10-18T12:00:00.000Z"),
    environments: [
      { id: laptop, name: "Laptop", status: "connected" },
      { id: desktop, name: "Desktop", status: "offline" },
    ],
    projects: [
      project(laptop, "api", "API", "2026-10-01T00:00:00.000Z"),
      project(laptop, "web", "Web", "2026-09-01T00:00:00.000Z"),
    ],
    threads: [
      thread(laptop, "older", "2026-10-10T00:00:00.000Z"),
      thread(laptop, "newer", "2026-10-11T00:00:00.000Z", {
        latestUserMessageAt: "2026-10-17T00:00:00.000Z",
        hasPendingApprovals: true,
      }),
      thread(laptop, "archived", "2026-10-12T00:00:00.000Z", {
        archivedAt: "2026-10-12T00:00:00.000Z",
      }),
      thread(desktop, "elsewhere", "2026-10-09T00:00:00.000Z"),
    ],
  });

  it("lists live threads most recently active first, named for their environment and project", () => {
    expect(catalog.threads.map((row) => row.id)).toEqual(["newer", "older", "elsewhere"]);
    expect(catalog.threads[0]).toMatchObject({
      environmentName: "Laptop",
      projectName: "Web",
      status: "needs_input",
      lastActivityAt: "2026-10-17T00:00:00.000Z",
    });
    expect(catalog.threads[2]).toMatchObject({ environmentName: "Desktop", projectName: "" });
  });

  it("orders projects by their threads' activity and names the repository", () => {
    expect(catalog.projects.map((row) => [row.id, row.repository])).toEqual([
      ["web", "acme/web"],
      ["api", ""],
    ]);
    expect(catalog.environments.map((row) => row.connected)).toEqual([1, 0]);
  });
});
