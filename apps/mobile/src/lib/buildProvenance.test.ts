import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The parsing and URL building are covered in @t3tools/shared. What is only
 * testable here is the glue: reading the values back out of the Expo config.
 * That glue fails silently -- a wrong `extra` path yields a page that renders
 * "No record" on a build that has a perfectly good record -- so it is worth
 * pinning the shape the config actually carries.
 */

const mocks = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));

vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: mocks.extra };
    },
  },
}));

async function loadProvenance(build: unknown) {
  mocks.extra = build === undefined ? {} : { build };
  vi.resetModules();
  return import("./buildProvenance");
}

describe("mobile build provenance", () => {
  it("reads the values app.config.ts embeds under extra.build", async () => {
    const provenance = await loadProvenance({
      commit: "0123456789abcdef0123456789abcdef01234567",
      repoRemote: "https://github.com/colonelpanic8/t3code.git",
      date: "2026-07-27T03:26:20-07:00",
      dirty: false,
      stackBuildInfo: "",
    });

    expect(provenance.BUILD_COMMIT_SHORT).toBe("0123456789ab");
    expect(provenance.BUILD_REPO_LABEL).toBe("colonelpanic8/t3code");
    expect(provenance.BUILD_COMMIT_URL).toBe(
      "https://github.com/colonelpanic8/t3code/commit/0123456789abcdef0123456789abcdef01234567",
    );
    expect(provenance.BUILD_DIRTY).toBe(false);
  });

  it("reports no provenance rather than a placeholder when the build has none", async () => {
    const provenance = await loadProvenance(undefined);

    expect(provenance.BUILD_COMMIT).toBe("");
    expect(provenance.BUILD_COMMIT_URL).toBeNull();
    expect(provenance.STACK_PROVENANCE).toBeNull();
  });

  // The manifest round-trips through JSON, and a non-string here would throw
  // inside the parser on a screen the user opened to diagnose something else.
  it("ignores values that are not strings", async () => {
    const provenance = await loadProvenance({ commit: 42, stackBuildInfo: { entries: [] } });

    expect(provenance.BUILD_COMMIT).toBe("");
    expect(provenance.STACK_PROVENANCE).toBeNull();
  });

  it("parses an embedded stack record", async () => {
    const provenance = await loadProvenance({
      stackBuildInfo: JSON.stringify({
        schemaVersion: 1,
        manifest: "stack.toml",
        upstream: {
          remote: "https://github.com/pingdotgg/t3code",
          ref: "main",
          commit: "23ea08daf27a2f56b85e605dd3d36f66bd1a132d",
          subject: "test: account for lazy thread feed details",
          date: "2026-07-27T02:56:34-07:00",
        },
        fork: { remote: "https://github.com/colonelpanic8/t3code", branch: "t3code/stack" },
        entries: [{ label: "#4624", kind: "fork", status: "merged", commit: "abc1234" }],
      }),
    });

    expect(provenance.STACK_PROVENANCE?.entries).toHaveLength(1);
    expect(provenance.STACK_PROVENANCE?.entries[0]?.label).toBe("#4624");
    expect(provenance.STACK_PROVENANCE?.fork.branch).toBe("t3code/stack");
  });
});
