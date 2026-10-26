import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  AgentProfileError,
  agentProfileRoot,
  makeAgentProfileFiles,
} from "../AgentProfileFiles.ts";

/** What a profile thread hands Claude in place of the user's own context. */
export interface ClaudeAgentProfile {
  readonly instructions: string | undefined;
  /** Added as an additional directory; Claude loads its `.claude/skills`. */
  readonly directory: string;
  readonly mcpServers: Readonly<Record<string, unknown>> | undefined;
  readonly settings: Readonly<Record<string, unknown>> | undefined;
  readonly memoryDirectory: string;
}

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeMcpConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
);

export const claudeProfileDirectory = (path: Path.Path, stateDir: string, profileId: string) =>
  path.join(stateDir, "providers", "claude", "profiles", profileId);

/**
 * Reads a profile for a Claude thread: instructions from `claude/CLAUDE.md` or
 * `AGENTS.md`, skills linked under a generated directory, MCP servers from
 * `claude/mcp.json`, and settings from `claude/settings.json`. Auto-memory is
 * kept per profile and project.
 */
export const prepareClaudeAgentProfile = Effect.fn("prepareClaudeAgentProfile")(function* (input: {
  readonly profileId: string;
  readonly stateDir: string;
  readonly cwd: string | null;
}): Effect.fn.Return<ClaudeAgentProfile, AgentProfileError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const files = yield* makeAgentProfileFiles(input.profileId);
  const profileRoot = agentProfileRoot(path, input.stateDir, input.profileId);
  yield* files.requireProfileRoot(profileRoot);

  const directory = claudeProfileDirectory(path, input.stateDir, input.profileId);
  yield* files.syncSkills({
    profileRoot,
    provider: "claude",
    skillsPath: path.join(directory, ".claude", "skills"),
  });

  const readOptional = Effect.fn("prepareClaudeAgentProfile.readOptional")(function* (
    candidates: ReadonlyArray<string>,
  ) {
    const filePath = yield* files.findFirst(candidates);
    return filePath === undefined
      ? undefined
      : { path: filePath, text: yield* files.readText(filePath) };
  });
  const invalidJson = (filePath: string) => (cause: unknown) =>
    files.fail("file is not valid JSON of the expected shape", filePath, cause);

  const instructions = yield* readOptional([
    path.join(profileRoot, "claude", "CLAUDE.md"),
    path.join(profileRoot, "AGENTS.md"),
  ]);
  const mcpConfig = yield* readOptional([path.join(profileRoot, "claude", "mcp.json")]);
  const settings = yield* readOptional([path.join(profileRoot, "claude", "settings.json")]);
  return {
    instructions: instructions?.text,
    directory,
    mcpServers:
      mcpConfig === undefined
        ? undefined
        : (yield* decodeMcpConfig(mcpConfig.text).pipe(
            Effect.mapError(invalidJson(mcpConfig.path)),
          )).mcpServers,
    settings:
      settings === undefined
        ? undefined
        : yield* decodeJsonObject(settings.text).pipe(Effect.mapError(invalidJson(settings.path))),
    memoryDirectory: path.join(
      directory,
      "projects",
      (input.cwd ?? "global").replace(/[^A-Za-z0-9]/g, "-"),
      "memory",
    ),
  };
});
