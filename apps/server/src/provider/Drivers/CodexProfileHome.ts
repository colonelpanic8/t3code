import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  isNotSymlinkError,
  KNOWN_SHARED_DIRECTORIES,
  REPLACEABLE_SHARED_RUNTIME_ENTRIES,
} from "./CodexHomeLayout.ts";

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
// Profile entries that every provider reads from the profile root.
const PROVIDER_NEUTRAL_ENTRY_NAMES = new Set(["AGENTS.md", "skills"]);
const OVERLAY_LOCAL_ENTRY_NAMES = new Set(["log", "tmp", ".DS_Store"]);
const USER_AGENT_SKILLS_MAX_DEPTH = 3;

// Codex versions its memory databases (memories_1.sqlite and its -wal/-shm).
const isProfileEntry = (entryName: string) =>
  PROFILE_ENTRY_NAMES.has(entryName) || entryName.startsWith("memories_");

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

export class CodexProfileHomeError extends Schema.TaggedError<CodexProfileHomeError>()(
  "CodexProfileHomeError",
  {
    profileId: Schema.String,
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent profile '${this.profileId}': ${this.detail} (${this.path}).`;
  }
}

export const agentProfileRoot = (path: Path.Path, stateDir: string, profileId: string) =>
  path.join(stateDir, "profiles", profileId);

export const codexProfileHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
  profileId: string,
) => path.join(stateDir, "providers", "codex", instanceId, "profiles", profileId);

/**
 * Builds a `$CODEX_HOME` that shares auth, sessions, and runtime state with
 * `baseHomePath` while taking instructions, skills, and config from the
 * profile. A profile directory holds `AGENTS.md` and `skills/` for every
 * provider, plus Codex-only entries such as `codex/config.toml`.
 */
export const materializeCodexProfileHome = Effect.fn("materializeCodexProfileHome")(
  function* (input: {
    readonly profileId: string;
    readonly profileRoot: string;
    readonly baseHomePath: string;
    readonly profileHomePath: string;
  }): Effect.fn.Return<void, CodexProfileHomeError, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (detail: string, failedPath: string, cause?: unknown) =>
      new CodexProfileHomeError({
        profileId: input.profileId,
        path: failedPath,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const attempt = <A, E>(effect: Effect.Effect<A, E>, operation: string, target: string) =>
      effect.pipe(Effect.mapError((cause) => fail(`${operation} failed`, target, cause)));
    const isDirectory = (target: string) =>
      fileSystem.stat(target).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const exists = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    const readLinkState = (linkPath: string) =>
      fileSystem.readLink(linkPath).pipe(
        Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed<LinkState>({ _tag: "Missing" })
              : isNotSymlinkError(cause)
                ? Effect.succeed<LinkState>({ _tag: "NotSymlink" })
                : Effect.fail(fail("readLink failed", linkPath, cause)),
        }),
      );
    const readDirectory = (directory: string) =>
      attempt(fileSystem.readDirectory(directory), "readDirectory", directory);

    // `target === undefined` removes a stale link and leaves real entries to Codex.
    const syncLink = Effect.fn("materializeCodexProfileHome.syncLink")(function* (
      linkPath: string,
      target: string | undefined,
      replaceReal: boolean,
    ) {
      const existing = yield* readLinkState(linkPath);
      if (existing._tag === "Missing") {
        if (target !== undefined) {
          yield* attempt(fileSystem.symlink(target, linkPath), "symlink", linkPath);
        }
        return;
      }
      if (existing._tag === "NotSymlink") {
        if (target === undefined) return;
        if (!replaceReal) {
          return yield* fail(
            "a local entry blocks sharing it with the base Codex home; remove it",
            linkPath,
          );
        }
        yield* attempt(fileSystem.remove(linkPath, { recursive: true }), "remove", linkPath);
        yield* attempt(fileSystem.symlink(target, linkPath), "symlink", linkPath);
        return;
      }
      if (
        target !== undefined &&
        path.resolve(path.dirname(linkPath), existing.target) === target
      ) {
        return;
      }
      yield* attempt(fileSystem.remove(linkPath), "remove", linkPath);
      if (target !== undefined) {
        yield* attempt(fileSystem.symlink(target, linkPath), "symlink", linkPath);
      }
    });

    if (!(yield* isDirectory(input.profileRoot))) {
      return yield* fail("profile directory not found", input.profileRoot);
    }
    if (path.resolve(input.baseHomePath) === path.resolve(input.profileHomePath)) {
      return yield* fail(
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
      (directory) =>
        attempt(
          fileSystem.makeDirectory(directory, { recursive: true }),
          "makeDirectory",
          directory,
        ),
      { discard: true },
    );

    const sharedEntries = new Set<string>(sharedDirectories);
    for (const entryName of yield* readDirectory(input.baseHomePath)) {
      if (!isProfileEntry(entryName) && !OVERLAY_LOCAL_ENTRY_NAMES.has(entryName)) {
        sharedEntries.add(entryName);
      }
    }
    yield* Effect.forEach(
      sharedEntries,
      (entryName) =>
        syncLink(
          path.join(input.profileHomePath, entryName),
          path.join(input.baseHomePath, entryName),
          REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(entryName),
        ),
      { discard: true },
    );

    const profileSource = Effect.fn("materializeCodexProfileHome.profileSource")(function* (
      entryName: string,
    ) {
      const candidates = [
        path.join(input.profileRoot, "codex", entryName),
        ...(PROVIDER_NEUTRAL_ENTRY_NAMES.has(entryName)
          ? [path.join(input.profileRoot, entryName)]
          : []),
      ];
      for (const candidate of candidates) {
        if (yield* exists(candidate)) return candidate;
      }
      return undefined;
    });
    yield* Effect.forEach(
      [...PROFILE_ENTRY_NAMES].filter((entryName) => entryName !== "skills"),
      (entryName) =>
        Effect.flatMap(profileSource(entryName), (source) =>
          syncLink(path.join(input.profileHomePath, entryName), source, true),
        ),
      { discard: true },
    );

    // Codex writes bundled skills into `$CODEX_HOME/skills/.system`, so link each
    // profile skill instead of the directory to keep the profile untouched.
    const skillsPath = path.join(input.profileHomePath, "skills");
    if ((yield* readLinkState(skillsPath))._tag === "Symlink") {
      yield* attempt(fileSystem.remove(skillsPath), "remove", skillsPath);
    }
    yield* attempt(
      fileSystem.makeDirectory(skillsPath, { recursive: true }),
      "makeDirectory",
      skillsPath,
    );
    const profileSkills = new Map<string, string>();
    for (const sourceDirectory of [
      path.join(input.profileRoot, "skills"),
      path.join(input.profileRoot, "codex", "skills"),
    ]) {
      if (!(yield* isDirectory(sourceDirectory))) continue;
      for (const skillName of yield* readDirectory(sourceDirectory)) {
        if (!skillName.startsWith(".")) {
          profileSkills.set(skillName, path.join(sourceDirectory, skillName));
        }
      }
    }
    const linkedSkills = new Set([...(yield* readDirectory(skillsPath)), ...profileSkills.keys()]);
    yield* Effect.forEach(
      linkedSkills,
      (skillName) => syncLink(path.join(skillsPath, skillName), profileSkills.get(skillName), true),
      { discard: true },
    );
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
