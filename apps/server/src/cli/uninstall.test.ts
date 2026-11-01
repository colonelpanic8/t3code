import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { findOwnedLauncher, keptStorageMessage, spawnWindowsRemoval } from "./uninstall.ts";

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
it("tells a legacy install to remove its whole T3 home, after its worktrees", () => {
  // A leftover ~/.t3/caches alone keeps a later install on the legacy layout,
  // and the worktrees may hold uncommitted work.
  assert.equal(
    keptStorageMessage({
      keptDirs: ["/home/a/.t3/userdata", "/home/a/.t3/caches", "/home/a/.t3/worktrees"],
      legacyHome: "/home/a/.t3",
      worktreesDir: "/home/a/.t3/worktrees",
    }),
    "Your projects, threads, and settings under /home/a/.t3/userdata, /home/a/.t3/caches, /home/a/.t3/worktrees are kept. To remove them too, move anything you want out of /home/a/.t3/worktrees, then delete /home/a/.t3 entirely; a later install keeps using anything left in it.",
  );
  assert.equal(
    keptStorageMessage({
      keptDirs: ["/home/a/.t3/userdata", "/srv/t3"],
      legacyHome: "/home/a/.t3",
      worktreesDir: "/home/a/.t3/worktrees",
    }),
    "Your projects, threads, and settings under /home/a/.t3/userdata, /srv/t3 are kept. To remove them too, move anything you want out of /home/a/.t3/worktrees, then delete /home/a/.t3 entirely and the other directories listed; a later install keeps using anything left in it.",
  );
  assert.equal(
    keptStorageMessage({
      keptDirs: ["/c", "/d"],
      legacyHome: undefined,
      worktreesDir: "/d/worktrees",
    }),
    "Your projects, threads, and settings under /c, /d are kept. Delete those directories yourself if you want them gone too, after moving anything you want out of /d/worktrees.",
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "t3 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(process.env.ComSpec ?? "cmd.exe", runtimeDir);
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
