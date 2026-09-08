import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  searchVoiceLiveProjects,
  type VoiceLiveProjectCandidate,
} from "./VoiceLiveProjectSearch.ts";

const candidate = (
  environmentId: string,
  projectId: string,
  title: string,
  workspaceRoot: string,
): VoiceLiveProjectCandidate => ({
  environmentId: EnvironmentId.make(environmentId),
  hostLabel: `host-${environmentId}`,
  projectId: ProjectId.make(projectId),
  title,
  workspaceRoot,
});

const desktopApi = candidate("env-desktop", "p1", "API Server", "/home/u/code/api-server");
const laptopApi = candidate("env-laptop", "p2", "api-server", "/work/api-server");
const laptopWeb = candidate("env-laptop", "p3", "Web App", "/work/web-app");

describe("searchVoiceLiveProjects", () => {
  it("matches a spoken name against titles ignoring case, punctuation, and hyphens", () => {
    const result = searchVoiceLiveProjects("Api Server", [desktopApi, laptopWeb]);
    expect(result.resolution).toBe("unique_exact");
    expect(result.matches[0]?.projectId).toBe("p1");
  });

  it("matches against the workspace directory name", () => {
    const byDir = candidate("env-a", "p9", "Frontend", "/srv/checkouts/billing-ui");
    const result = searchVoiceLiveProjects("billing ui", [byDir, laptopWeb]);
    expect(result.resolution).toBe("unique_exact");
    expect(result.matches[0]?.projectId).toBe("p9");
  });

  it("reports ambiguity when several projects share the spoken name", () => {
    const result = searchVoiceLiveProjects("api server", [desktopApi, laptopApi, laptopWeb]);
    expect(result.resolution).toBe("ambiguous_exact");
    expect(result.matches).toHaveLength(2);
  });

  it("falls back to partial matches only when nothing matches exactly", () => {
    const result = searchVoiceLiveProjects("api", [desktopApi, laptopWeb]);
    expect(result.resolution).toBe("unique_partial");
    expect(result.matches[0]?.matchKind).toBe("partial");
  });

  it("returns none for unmatched and unusable queries", () => {
    expect(searchVoiceLiveProjects("nonexistent", [desktopApi]).resolution).toBe("none");
    expect(searchVoiceLiveProjects("---", [desktopApi]).resolution).toBe("none");
  });
});
