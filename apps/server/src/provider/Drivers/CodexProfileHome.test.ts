import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { AgentProfileError } from "../AgentProfileFiles.ts";
import { codexProfileThreadConfig, materializeCodexProfileHome } from "./CodexProfileHome.ts";

const makeTempDir = Effect.fn("CodexProfileHome.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexProfileHome.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const makeHomes = Effect.fn("CodexProfileHome.test.makeHomes")(function* () {
  const path = yield* Path.Path;
  const baseHomePath = yield* makeTempDir("t3code-codex-base-");
  const profileRoot = yield* makeTempDir("t3code-agent-profile-");
  const profileHomePath = path.join(yield* makeTempDir("t3code-codex-profile-home-"), "home");
  yield* writeTextFile(path.join(baseHomePath, "auth.json"), "base auth");
  yield* writeTextFile(path.join(baseHomePath, "AGENTS.md"), "base instructions");
  yield* writeTextFile(path.join(baseHomePath, "config.toml"), "[mcp_servers.base]");
  yield* writeTextFile(path.join(baseHomePath, "memories_1.sqlite"), "base memories");
  yield* writeTextFile(path.join(baseHomePath, "skills", "base-skill", "SKILL.md"), "base skill");
  yield* writeTextFile(path.join(profileRoot, "AGENTS.md"), "profile instructions");
  yield* writeTextFile(path.join(profileRoot, "codex", "config.toml"), 'model = "profile"');
  yield* writeTextFile(path.join(profileRoot, "skills", "shared-skill", "SKILL.md"), "skill");
  yield* writeTextFile(
    path.join(profileRoot, "codex", "skills", "codex-skill", "SKILL.md"),
    "skill",
  );
  return {
    profileId: "focus",
    baseHomePath,
    profileRoot,
    profileHomePath,
  };
});

it.layer(NodeServices.layer)("CodexProfileHome", (it) => {
  describe("materializeCodexProfileHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "shares auth and sessions while taking context from the profile",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homes = yield* makeHomes();
          const inHome = (...segments: Array<string>) =>
            path.join(homes.profileHomePath, ...segments);

          yield* materializeCodexProfileHome(homes);

          expect(yield* fileSystem.readFileString(inHome("auth.json"))).toBe("base auth");
          expect(yield* fileSystem.readLink(inHome("sessions"))).toBe(
            path.join(homes.baseHomePath, "sessions"),
          );
          expect(yield* fileSystem.readFileString(inHome("AGENTS.md"))).toBe(
            "profile instructions",
          );
          expect(yield* fileSystem.readFileString(inHome("config.toml"))).toBe('model = "profile"');
          expect(yield* fileSystem.exists(inHome("memories_1.sqlite"))).toBe(false);
          expect((yield* fileSystem.readDirectory(inHome("skills"))).toSorted()).toEqual([
            "codex-skill",
            "shared-skill",
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "follows profile edits without touching entries Codex created",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homes = yield* makeHomes();
          const inHome = (...segments: Array<string>) =>
            path.join(homes.profileHomePath, ...segments);

          yield* materializeCodexProfileHome(homes);
          yield* writeTextFile(inHome("skills", ".system", "imagegen", "SKILL.md"), "system");
          yield* writeTextFile(inHome("memories_1.sqlite"), "profile memories");
          yield* fileSystem.remove(path.join(homes.profileRoot, "AGENTS.md"));
          yield* fileSystem.remove(path.join(homes.profileRoot, "skills"), { recursive: true });
          yield* materializeCodexProfileHome(homes);

          expect(yield* fileSystem.exists(inHome("AGENTS.md"))).toBe(false);
          expect((yield* fileSystem.readDirectory(inHome("skills"))).toSorted()).toEqual([
            ".system",
            "codex-skill",
          ]);
          expect(yield* fileSystem.readFileString(inHome("memories_1.sqlite"))).toBe(
            "profile memories",
          );
          expect(yield* fileSystem.exists(path.join(homes.profileRoot, "skills"))).toBe(false);
        }),
    );

    it.effect("fails when the profile directory is missing", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homes = yield* makeHomes();

        const error = yield* materializeCodexProfileHome({
          ...homes,
          profileRoot: path.join(homes.profileRoot, "missing"),
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(AgentProfileError);
        expect(error.detail).toBe("profile directory not found");
      }),
    );
  });

  describe("codexProfileThreadConfig", () => {
    it.effect("disables every skill under ~/.agents/skills", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = yield* makeTempDir("t3code-home-");
        const skills = path.join(home, ".agents", "skills");
        yield* writeTextFile(path.join(skills, "alpha", "SKILL.md"), "alpha");
        yield* writeTextFile(path.join(skills, "bundle", "beta", "SKILL.md"), "beta");

        expect(yield* codexProfileThreadConfig(home)).toEqual({
          "skills.config": [
            { path: path.join(skills, "alpha", "SKILL.md"), enabled: false },
            { path: path.join(skills, "bundle", "beta", "SKILL.md"), enabled: false },
          ],
        });
        expect(yield* codexProfileThreadConfig(path.join(home, "missing"))).toEqual({});
      }),
    );
  });
});
