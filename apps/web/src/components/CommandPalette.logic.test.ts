import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  resolveBrowseAvailability,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("resolveBrowseAvailability", () => {
  it("allows browsing a connected environment", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "workstation",
        connectionPhase: "connected",
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({ _tag: "Available" });
  });

  it("blocks browsing an environment that is not connected", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "workstation",
        connectionPhase: "available",
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "workstation isn't connected, so its files can't be browsed.",
    });
  });

  it("blocks browsing an offline environment", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "workstation",
        connectionPhase: "offline",
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "workstation is offline, so its files can't be browsed.",
    });
  });

  it("surfaces the connection failure reason when the environment is unreachable", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "remote-box",
        connectionPhase: "error",
        connectionError: "ssh: connect: host unreachable",
        browseError: null,
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "Can't reach remote-box. Reason: ssh: connect: host unreachable",
    });
  });

  it("reports a bare unreachable message when no reason is available", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "remote-box",
        connectionPhase: "error",
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({ _tag: "Unavailable", message: "Can't reach remote-box." });
  });

  it("reports transient reconnects without claiming the host is gone", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "remote-box",
        connectionPhase: "reconnecting",
        connectionError: "socket closed",
        browseError: null,
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "Reconnecting to remote-box. Reason: socket closed",
    });
  });

  it("surfaces a browse failure on an otherwise connected environment", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: "remote-box",
        connectionPhase: "connected",
        connectionError: null,
        browseError: "EACCES: permission denied",
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "Can't browse remote-box. Reason: EACCES: permission denied",
    });
  });

  it("falls back to a generic label when the environment has no label", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: null,
        connectionPhase: "offline",
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({
      _tag: "Unavailable",
      message: "this environment is offline, so its files can't be browsed.",
    });
  });

  it("blocks browsing when no environment is selected", () => {
    expect(
      resolveBrowseAvailability({
        environmentLabel: null,
        connectionPhase: null,
        connectionError: null,
        browseError: null,
      }),
    ).toEqual({ _tag: "Unavailable", message: "Select an environment to browse." });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});
