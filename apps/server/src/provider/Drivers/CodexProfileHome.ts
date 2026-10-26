import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AgentProfileError, makeAgentProfileFiles } from "../AgentProfileFiles.ts";
import { KNOWN_SHARED_DIRECTORIES, REPLACEABLE_SHARED_RUNTIME_ENTRIES } from "./CodexHomeLayout.ts";

/**
 * `$CODEX_HOME` entries that carry user-level context. A profile home takes
 * these from the profile (or leaves them to Codex) instead of the base home.
 */
const PROFILE_ENTRY_NAMES = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "config.toml",
  "skills",
  "plugins",
  "agents",
  "hooks",
  "hooks.json",
  "prompts",
  "memories",
]);
const OVERLAY_LOCAL_ENTRY_NAMES = new Set(["log", "tmp", ".DS_Store"]);
const USER_AGENT_SKILLS_MAX_DEPTH = 3;

// Codex versions its memory databases (memories_1.sqlite and its -wal/-shm).
const isProfileEntry = (entryName: string) =>
  PROFILE_ENTRY_NAMES.has(entryName) || entryName.startsWith("memories_");

export const codexProfileHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
  profileId: string,
) => path.join(stateDir, "providers", "codex", instanceId, "profiles", profileId);

/**
 * Builds a `$CODEX_HOME` that shares auth, sessions, and runtime state with
 * `baseHomePath` while taking instructions, skills, and config from the
 * profile.
 */
export const materializeCodexProfileHome = Effect.fn("materializeCodexProfileHome")(
  function* (input: {
    readonly profileId: string;
    readonly profileRoot: string;
    readonly baseHomePath: string;
    readonly profileHomePath: string;
  }): Effect.fn.Return<void, AgentProfileError, FileSystem.FileSystem | Path.Path> {
    const path = yield* Path.Path;
    const files = yield* makeAgentProfileFiles(input.profileId);

    yield* files.requireProfileRoot(input.profileRoot);
    if (path.resolve(input.baseHomePath) === path.resolve(input.profileHomePath)) {
      return yield* files.fail(
        "profile home must differ from the base Codex home",
        input.profileHomePath,
      );
    }

    const sharedDirectories = KNOWN_SHARED_DIRECTORIES.filter((entry) => !isProfileEntry(entry));
    yield* Effect.forEach(
      [
        input.profileHomePath,
        ...sharedDirectories.map((directory) => path.join(input.baseHomePath, directory)),
      ],
      files.makeDirectory,
      { discard: true },
    );

    const sharedEntries = new Set<string>(sharedDirectories);
    for (const entryName of yield* files.readDirectory(input.baseHomePath)) {
      if (!isProfileEntry(entryName) && !OVERLAY_LOCAL_ENTRY_NAMES.has(entryName)) {
        sharedEntries.add(entryName);
      }
    }
    yield* Effect.forEach(
      sharedEntries,
      (entryName) =>
        files.syncLink(
          path.join(input.profileHomePath, entryName),
          path.join(input.baseHomePath, entryName),
          REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(entryName),
        ),
      { discard: true },
    );

    yield* Effect.forEach(
      [...PROFILE_ENTRY_NAMES].filter((entryName) => entryName !== "skills"),
      (entryName) =>
        Effect.flatMap(
          files.findFirst([
            path.join(input.profileRoot, "codex", entryName),
            ...(entryName === "AGENTS.md" ? [path.join(input.profileRoot, entryName)] : []),
          ]),
          (source) => files.syncLink(path.join(input.profileHomePath, entryName), source, true),
        ),
      { discard: true },
    );

    yield* files.syncSkills({
      profileRoot: input.profileRoot,
      provider: "codex",
      skillsPath: path.join(input.profileHomePath, "skills"),
    });
  },
);

/**
 * Codex also loads `~/.agents/skills`, which a profile home cannot hide, so a
 * profile thread disables each of those skills by path.
 */
export const codexProfileThreadConfig = Effect.fn("codexProfileThreadConfig")(function* (
  homeDirectory: string,
): Effect.fn.Return<
  Readonly<Record<string, Schema.Json>>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillFiles: Array<string> = [];
  const visit = Effect.fn("codexProfileThreadConfig.visit")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never, never> {
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entryName of [...entries].sort()) {
      const entryPath = path.join(directory, entryName);
      if (entryName === "SKILL.md") {
        skillFiles.push(entryPath);
      } else if (depth < USER_AGENT_SKILLS_MAX_DEPTH) {
        const isDirectory = yield* fileSystem.stat(entryPath).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
        if (isDirectory) yield* visit(entryPath, depth + 1);
      }
    }
  });
  yield* visit(path.join(homeDirectory, ".agents", "skills"), 0);
  return skillFiles.length === 0
    ? {}
    : { "skills.config": skillFiles.map((skillFile) => ({ path: skillFile, enabled: false })) };
});
