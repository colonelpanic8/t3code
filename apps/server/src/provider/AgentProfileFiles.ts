import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isNotSymlinkError } from "./Drivers/CodexHomeLayout.ts";

/**
 * An agent profile is a directory under `<stateDir>/profiles`. `AGENTS.md` and
 * `skills/` at its root apply to every provider; `<provider>/` subdirectories
 * hold provider-specific entries, such as `codex/config.toml`.
 */
export const agentProfilesDirectory = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "profiles");

export const agentProfileRoot = (path: Path.Path, stateDir: string, profileId: string) =>
  path.join(agentProfilesDirectory(path, stateDir), profileId);

export class AgentProfileError extends Schema.TaggedError<AgentProfileError>()(
  "AgentProfileError",
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

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

/** Filesystem helpers that report failures as an AgentProfileError for `profileId`. */
export const makeAgentProfileFiles = Effect.fn("makeAgentProfileFiles")(function* (
  profileId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string, failedPath: string, cause?: unknown) =>
    new AgentProfileError({
      profileId,
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
  const makeDirectory = (directory: string) =>
    attempt(fileSystem.makeDirectory(directory, { recursive: true }), "makeDirectory", directory);

  const requireProfileRoot = Effect.fn("AgentProfileFiles.requireProfileRoot")(function* (
    profileRoot: string,
  ) {
    if (!(yield* isDirectory(profileRoot))) {
      return yield* fail("profile directory not found", profileRoot);
    }
  });

  /**
   * Points `linkPath` at `target`. Without a target it removes a stale link and
   * leaves a real entry alone; with one it replaces a real entry only when
   * `replaceReal` allows it.
   */
  const syncLink = Effect.fn("AgentProfileFiles.syncLink")(function* (
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
        return yield* fail("a local entry is in the way of a shared link; remove it", linkPath);
      }
      yield* attempt(fileSystem.remove(linkPath, { recursive: true }), "remove", linkPath);
      yield* attempt(fileSystem.symlink(target, linkPath), "symlink", linkPath);
      return;
    }
    if (target !== undefined && path.resolve(path.dirname(linkPath), existing.target) === target) {
      return;
    }
    yield* attempt(fileSystem.remove(linkPath), "remove", linkPath);
    if (target !== undefined) {
      yield* attempt(fileSystem.symlink(target, linkPath), "symlink", linkPath);
    }
  });

  /**
   * Makes `skillsPath` a real directory with one link per skill from the
   * profile's shared and `<provider>/skills` directories. Providers may write
   * their own entries there (Codex adds `.system`); those are left alone.
   */
  const syncSkills = Effect.fn("AgentProfileFiles.syncSkills")(function* (input: {
    readonly profileRoot: string;
    readonly provider: string;
    readonly skillsPath: string;
  }) {
    if ((yield* readLinkState(input.skillsPath))._tag === "Symlink") {
      yield* attempt(fileSystem.remove(input.skillsPath), "remove", input.skillsPath);
    }
    yield* makeDirectory(input.skillsPath);
    const profileSkills = new Map<string, string>();
    for (const sourceDirectory of [
      path.join(input.profileRoot, "skills"),
      path.join(input.profileRoot, input.provider, "skills"),
    ]) {
      if (!(yield* isDirectory(sourceDirectory))) continue;
      for (const skillName of yield* readDirectory(sourceDirectory)) {
        if (!skillName.startsWith(".")) {
          profileSkills.set(skillName, path.join(sourceDirectory, skillName));
        }
      }
    }
    const skillNames = new Set([
      ...(yield* readDirectory(input.skillsPath)),
      ...profileSkills.keys(),
    ]);
    yield* Effect.forEach(
      skillNames,
      (skillName) =>
        syncLink(path.join(input.skillsPath, skillName), profileSkills.get(skillName), true),
      { discard: true },
    );
  });

  /** The first of `candidates` that exists. */
  const findFirst = Effect.fn("AgentProfileFiles.findFirst")(function* (
    candidates: ReadonlyArray<string>,
  ) {
    for (const candidate of candidates) {
      if (yield* exists(candidate)) return candidate;
    }
    return undefined;
  });

  const readText = (filePath: string) =>
    attempt(fileSystem.readFileString(filePath), "readFile", filePath);

  return {
    fail,
    attempt,
    exists,
    readDirectory,
    makeDirectory,
    requireProfileRoot,
    syncLink,
    syncSkills,
    findFirst,
    readText,
  } as const;
});
