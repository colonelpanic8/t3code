import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { prepareClaudeAgentProfile } from "./ClaudeProfileContext.ts";

const writeTextFile = Effect.fn("ClaudeProfileContext.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("ClaudeProfileContext", (it) => {
  describe("prepareClaudeAgentProfile", () => {
    it.effect.skipIf(!symlinksSupported)("reads instructions, skills, MCP, and settings", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });
        const profileRoot = path.join(stateDir, "profiles", "focus");
        yield* writeTextFile(path.join(profileRoot, "AGENTS.md"), "shared instructions");
        yield* writeTextFile(path.join(profileRoot, "claude", "CLAUDE.md"), "claude instructions");
        yield* writeTextFile(path.join(profileRoot, "skills", "shared", "SKILL.md"), "skill");
        yield* writeTextFile(
          path.join(profileRoot, "claude", "mcp.json"),
          JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://docs.test" } } }),
        );
        yield* writeTextFile(
          path.join(profileRoot, "claude", "settings.json"),
          JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
        );

        const profile = yield* prepareClaudeAgentProfile({
          profileId: "focus",
          stateDir,
          cwd: "/work/repo",
        });

        expect(profile.instructions).toBe("claude instructions");
        expect(profile.mcpServers).toEqual({ docs: { type: "http", url: "http://docs.test" } });
        expect(profile.settings).toEqual({ permissions: { allow: ["Bash(ls)"] } });
        expect(profile.memoryDirectory).toBe(
          path.join(profile.directory, "projects", "-work-repo", "memory"),
        );
        expect(
          yield* fileSystem.readFileString(
            path.join(profile.directory, ".claude", "skills", "shared", "SKILL.md"),
          ),
        ).toBe("skill");
      }),
    );

    it.effect("rejects an MCP config without an mcpServers object", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-state-" });
        const mcpPath = path.join(stateDir, "profiles", "focus", "claude", "mcp.json");
        yield* writeTextFile(mcpPath, JSON.stringify({ servers: {} }));

        const error = yield* prepareClaudeAgentProfile({
          profileId: "focus",
          stateDir,
          cwd: null,
        }).pipe(Effect.flip);

        expect(error.path).toBe(mcpPath);
      }),
    );
  });
});
