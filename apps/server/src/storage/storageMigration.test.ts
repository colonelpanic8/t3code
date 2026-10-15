// @effect-diagnostics nodeBuiltinImport:off - Builds real SQLite fixtures and symlinks, and crashes a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  resolveDefaultT3StorageRoots,
  resolveLegacyT3StorageRoots,
  resolveT3ClientStorageRoots,
  selectT3Storage,
  t3StoragePathExists,
} from "@t3tools/shared/storagePaths";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  planStorageMigration,
  rollbackStorageMigration,
  runStorageMigration,
  StorageMigrationBlockedError,
  StorageMigrationConflictError,
  StorageMigrationCopyError,
  type StorageMigrationInput,
  StorageMigrationMoveError,
  StorageMigrationVerificationError,
} from "./storageMigration.ts";
import { StorageMigrationReadError } from "./storageMigrationFiles.ts";

const DEAD_PID = 2 ** 22 + 1;

/**
 * A legacy install with a database, server and client files, and a desktop
 * profile, migrating into the split defaults of the same home, so selection
 * sees exactly what a real start would.
 */
const makeFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-migration-" });
  const home = path.join(root, "home");
  const legacyRoots = resolveLegacyT3StorageRoots({
    baseDir: path.join(home, ".t3"),
    stateDirectoryName: "userdata",
    path,
  });
  const state = legacyRoots.stateDir;
  yield* fs.makeDirectory(path.join(state, "secrets"), { recursive: true });
  yield* fs.makeDirectory(path.join(state, "attachments"), { recursive: true });
  yield* fs.makeDirectory(path.join(state, "logs"), { recursive: true });
  yield* fs.makeDirectory(path.join(state, "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(home, ".t3", "worktrees"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(path.join(state, "statev2.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('a'), ('b'), ('c')");
  database.close();
  yield* fs.writeFileString(path.join(state, "settings.json"), '{"server":true}');
  yield* fs.writeFileString(path.join(state, "environment-id"), "environment-1");
  yield* fs.writeFileString(path.join(state, "client-settings.json"), '{"client":true}');
  yield* fs.writeFileString(path.join(state, "connection-catalog.json"), '{"version":1}');
  yield* fs.writeFileString(path.join(state, "desktop-window-state.json"), '{"x":1}');
  yield* fs.writeFileString(path.join(state, "clerk-tokens.json"), "{}");
  yield* fs.writeFileString(path.join(state, "bin", "t3"), "#!/bin/sh\n");
  yield* fs.makeDirectory(path.join(state, "themes"), { recursive: true });
  yield* fs.writeFileString(path.join(state, "themes", "dusk.json"), "{}");
  yield* fs.writeFileString(path.join(state, "secrets", "server-signing-key.bin"), "key");
  yield* fs.chmod(path.join(state, "secrets", "server-signing-key.bin"), 0o600);
  yield* fs.writeFileString(path.join(state, "attachments", "image.png"), "png");
  yield* fs.writeFileString(path.join(state, "logs", "server.trace.ndjson"), "{}");
  yield* fs.writeFileString(
    path.join(state, "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: DEAD_PID,
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: "2026-10-01T00:00:00.000Z",
    }),
  );
  const legacyProfile = path.join(home, ".config", "t3code-v2");
  yield* fs.makeDirectory(path.join(legacyProfile, "Local Storage"), { recursive: true });
  yield* fs.makeDirectory(path.join(legacyProfile, "Cache", "Cache_Data"), { recursive: true });
  yield* fs.makeDirectory(path.join(legacyProfile, "GPUCache"), { recursive: true });
  yield* fs.writeFileString(path.join(legacyProfile, "Local State"), "{}");
  yield* fs.writeFileString(path.join(legacyProfile, "Local Storage", "CURRENT"), "x");
  yield* fs.writeFileString(path.join(legacyProfile, "Cache", "Cache_Data", "index"), "c");
  yield* fs.writeFileString(path.join(legacyProfile, "GPUCache", "data_0"), "g");
  yield* fs.symlink(
    `${NodeOS.hostname()}-${String(DEAD_PID)}`,
    path.join(legacyProfile, "SingletonLock"),
  );

  const storageHost = {
    platform: "linux" as const,
    homeDirectory: home,
    temporaryDirectory: root,
    isDevelopment: false,
    environment: {},
    path,
  };
  const serverRoots = resolveDefaultT3StorageRoots(storageHost);
  const clientRoots = resolveT3ClientStorageRoots({ ...storageHost, serverRoots });
  const split = (name: "config" | "data" | "state" | "runtime") => serverRoots[`${name}Dir`];
  const client = (name: "config" | "state") => clientRoots[`${name}Dir`];
  const input: StorageMigrationInput = {
    legacyRoots,
    serverRoots,
    clientRoots,
    serverOverrides: {},
    legacyElectronProfile: legacyProfile,
    electronProfile: path.join(client("state"), "electron"),
  };
  /** The layout a T3 process started now would use. */
  const selectedLayout = () => {
    const selection = selectT3Storage({ ...storageHost, exists: t3StoragePathExists });
    return selection._tag === "Selected" ? selection.roots.layout : selection._tag;
  };
  return { root, home, input, state, split, client, legacyProfile, selectedLayout };
});

const countThreads = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare("SELECT count(*) AS count FROM threads").get()?.count);
  } finally {
    database.close();
  }
};

/** Runs the migration in a child process that SIGKILLs itself when it first writes `killAt`. */
const migrateUntilKilled = (input: StorageMigrationInput, killAt: string) => {
  const moduleUrl = NodeURL.pathToFileURL(
    NodePath.join(import.meta.dirname, "storageMigration.ts"),
  ).href;
  const script = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { runStorageMigration } from ${JSON.stringify(moduleUrl)};
const [input, killAt] = JSON.parse(process.argv[1]);
const kill = (target, write) =>
  target.startsWith(killAt) ? Effect.sync(() => process.kill(process.pid, "SIGKILL")) : write();
const crashing = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => ({
    ...fs,
    rename: (from, to) => kill(to, () => fs.rename(from, to)),
    copyFile: (from, to) => kill(to, () => fs.copyFile(from, to)),
  })),
);
await Effect.runPromise(
  runStorageMigration(input, { replaceExisting: false }).pipe(
    Effect.provide(crashing),
    Effect.provide(NodeServices.layer),
  ),
);
process.exit(0);
`;
  return NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify([input, killAt])],
    { cwd: NodePath.join(import.meta.dirname, "..", ".."), encoding: "utf8" },
  );
};

/** A FileSystem whose writes fail or misbehave for one path, to drive failure paths. */
const sabotage = (overrides: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({ ...fs, ...overrides(fs) })),
  ).pipe(Layer.provide(NodeServices.layer));

describe("storage migration", () => {
  it.effect("copies each file to its owner's split root and retires the legacy tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, client, selectedLayout } = yield* makeFixture();
      assert.equal(selectedLayout(), "legacy");

      const plan = yield* planStorageMigration(input);
      assert.isFalse(yield* fs.exists(split("state")));
      assert.deepInclude(plan.skipped, {
        path: path.join(state, "logs"),
        reason: "log history stays in the legacy tree",
      });
      assert.isUndefined(plan.entries.find((entry) => entry.source.endsWith("bin")));

      const result = yield* runStorageMigration(input, { replaceExisting: false });
      assert.isTrue(result.migrated);
      assert.equal(selectedLayout(), "split");
      assert.equal(countThreads(path.join(split("state"), "statev2.sqlite")), 3);
      assert.equal(
        yield* fs.readFileString(path.join(split("config"), "settings.json")),
        '{"server":true}',
      );
      assert.equal(
        yield* fs.readFileString(path.join(client("config"), "client-settings.json")),
        '{"client":true}',
      );
      assert.isTrue(yield* fs.exists(path.join(client("state"), "connection-catalog.json")));
      assert.isTrue(yield* fs.exists(path.join(client("state"), "desktop-window-state.json")));
      assert.isTrue(yield* fs.exists(path.join(client("state"), "clerk-tokens.json")));
      assert.isTrue(yield* fs.exists(path.join(split("config"), "themes", "dusk.json")));
      assert.isTrue(yield* fs.exists(path.join(split("data"), "attachments", "image.png")));
      assert.equal(
        (yield* fs.stat(path.join(split("state"), "secrets", "server-signing-key.bin"))).mode &
          0o777,
        0o600,
      );
      assert.isTrue(yield* fs.exists(path.join(input.electronProfile, "Local Storage", "CURRENT")));
      assert.isFalse(yield* fs.exists(path.join(input.electronProfile, "SingletonLock")));
      assert.isFalse(yield* fs.exists(path.join(input.electronProfile, "Cache")));
      assert.isFalse(yield* fs.exists(path.join(input.electronProfile, "GPUCache")));
      assert.isFalse(yield* fs.exists(path.join(split("state"), "logs")));
      assert.isFalse(yield* fs.exists(path.join(split("state"), "bin")));
      assert.isFalse(yield* fs.exists(path.join(split("runtime"), "server-runtime.json")));
      // Sources are untouched; only the marker is added.
      assert.equal(countThreads(path.join(state, "statev2.sqlite")), 3);
      assert.isTrue(yield* fs.exists(path.join(state, "settings.json")));
      assert.isTrue(yield* fs.exists(path.join(state, "storage-migration.json")));
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.pending.json")));

      const again = yield* runStorageMigration(input, { replaceExisting: false });
      assert.isFalse(again.migrated);
      assert.isDefined(again.plan.migratedAt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("snapshots writes still in an uncheckpointed WAL", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      const writer = new NodeSqlite.DatabaseSync(path.join(state, "statev2.sqlite"));
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.exec("INSERT INTO threads VALUES ('d'), ('e')");

      yield* runStorageMigration(input, { replaceExisting: false });

      assert.equal(countThreads(path.join(split("state"), "statev2.sqlite")), 5);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["while copying the desktop profile", "electronProfile"],
    ["while placing the database", "database"],
    ["while writing the marker", "marker"],
  ] as const)(
    "keeps the legacy tree in use after a crash %s, and a rerun completes",
    ([, crashPoint]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { input, state, split, selectedLayout } = yield* makeFixture();
        const killAt =
          crashPoint === "electronProfile"
            ? input.electronProfile
            : crashPoint === "database"
              ? path.join(split("state"), "statev2.sqlite")
              : path.join(state, "storage-migration.json");

        const child = migrateUntilKilled(input, killAt);
        assert.equal(child.signal, "SIGKILL", child.stderr);
        assert.equal(selectedLayout(), "legacy");
        assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));

        const result = yield* runStorageMigration(input, { replaceExisting: false });
        assert.isTrue(result.migrated);
        assert.equal(selectedLayout(), "split");
        assert.equal(countThreads(path.join(split("state"), "statev2.sqlite")), 3);
        assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.pending.json")));
        const leftovers = (yield* fs.readDirectory(path.dirname(input.electronProfile))).filter(
          (name) => name.includes(".migrating-"),
        );
        assert.deepEqual(leftovers, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect("recreates top-level symlinks instead of copying through them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, input, state, split } = yield* makeFixture();
      const dotfiles = path.join(root, "dotfiles");
      const otherDisk = path.join(root, "other-disk", "attachments");
      yield* fs.makeDirectory(dotfiles);
      yield* fs.makeDirectory(otherDisk, { recursive: true });
      yield* fs.writeFileString(path.join(dotfiles, "keybindings.json"), "[]");
      yield* fs.writeFileString(path.join(otherDisk, "big.png"), "png");
      yield* fs.symlink("../../../dotfiles/keybindings.json", path.join(state, "keybindings.json"));
      yield* fs.remove(path.join(state, "attachments"), { recursive: true });
      yield* fs.symlink(otherDisk, path.join(state, "attachments"));

      const plan = yield* planStorageMigration(input);
      const link = plan.entries.find((entry) => entry.source.endsWith("keybindings.json"));
      assert.equal(link?.kind, "symlink");
      assert.equal(link?.linkTarget, path.join(dotfiles, "keybindings.json"));

      yield* runStorageMigration(input, { replaceExisting: false });

      assert.equal(
        yield* fs.readLink(path.join(split("config"), "keybindings.json")),
        path.join(dotfiles, "keybindings.json"),
      );
      assert.equal(yield* fs.readLink(path.join(split("data"), "attachments")), otherDisk);
      assert.deepEqual(yield* fs.readDirectory(otherDisk), ["big.png"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails instead of verifying a tree it could not fully read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      const locked = path.join(state, "attachments", "locked");
      yield* fs.makeDirectory(locked);
      yield* fs.writeFileString(path.join(locked, "secret.png"), "png");
      yield* fs.chmod(locked, 0o000);
      yield* Effect.addFinalizer(() => fs.chmod(locked, 0o700).pipe(Effect.ignore));

      const error = yield* runStorageMigration(input, { replaceExisting: false }).pipe(Effect.flip);

      assert.instanceOf(error, StorageMigrationReadError);
      assert.isFalse(yield* fs.exists(path.join(split("data"), "attachments")));
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("places nothing when a copy cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, client } = yield* makeFixture();
      yield* fs.makeDirectory(client("config"), { recursive: true });
      yield* fs.chmod(client("config"), 0o500);
      yield* Effect.addFinalizer(() => fs.chmod(client("config"), 0o700).pipe(Effect.ignore));

      const error = yield* runStorageMigration(input, { replaceExisting: false }).pipe(Effect.flip);

      assert.instanceOf(error, StorageMigrationCopyError);
      for (const directory of [split("config"), split("state"), split("data"), client("state")]) {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        assert.deepEqual(names, [], directory);
      }
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.pending.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("places nothing when a copy fails verification", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, client } = yield* makeFixture();
      const corrupting = sabotage((real) => ({
        copyFile: (from, to) =>
          real
            .copyFile(from, to)
            .pipe(
              Effect.andThen(
                from.endsWith("settings.json") && !from.endsWith("client-settings.json")
                  ? real.writeFileString(to, "corrupt")
                  : Effect.void,
              ),
            ),
      }));

      const error = yield* runStorageMigration(input, { replaceExisting: false }).pipe(
        Effect.provide(corrupting),
        Effect.flip,
      );

      assert.instanceOf(error, StorageMigrationVerificationError);
      for (const directory of [split("config"), split("state"), split("data"), client("state")]) {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        assert.deepEqual(names, [], directory);
      }
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.pending.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("compares large files in chunks and catches a difference in the last one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      const large = new Uint8Array(3 * 1024 * 1024 + 7).fill(7);
      yield* fs.writeFile(path.join(state, "attachments", "large.bin"), large);
      yield* fs.makeDirectory(path.join(split("data"), "attachments"), { recursive: true });
      yield* fs.writeFile(path.join(split("data"), "attachments", "image.png"), Buffer.from("png"));
      const changed = large.slice();
      changed[changed.length - 1] = 8;
      yield* fs.writeFile(path.join(split("data"), "attachments", "large.bin"), changed);

      const plan = yield* planStorageMigration(input);
      assert.equal(
        plan.entries.find((entry) => entry.source.endsWith("attachments"))?.status,
        "conflict",
      );
      yield* fs.writeFile(path.join(split("data"), "attachments", "large.bin"), large);
      const matching = yield* planStorageMigration(input);
      assert.equal(
        matching.entries.find((entry) => entry.source.endsWith("attachments"))?.status,
        "present",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves files that a client dir or server override already holds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, input, state, split, client } = yield* makeFixture();
      const clientDir = path.join(root, "client-dir");
      const configDir = path.join(root, "server-config");
      const dataDir = path.join(root, "server-data");
      yield* fs.makeDirectory(clientDir);
      yield* fs.writeFileString(path.join(clientDir, "client-settings.json"), '{"live":true}');

      const result = yield* runStorageMigration(
        { ...input, clientDir, serverOverrides: { configDir, dataDir } },
        { replaceExisting: false },
      );

      assert.isTrue(result.migrated);
      assert.deepEqual(result.plan.entries.map((entry) => path.basename(entry.source)).toSorted(), [
        "clerk-tokens.json",
        "t3code-v2",
      ]);
      assert.deepInclude(result.plan.skipped, {
        path: path.join(state, "client-settings.json"),
        reason: `the client dir keeps the live copy at ${clientDir} in either layout`,
      });
      assert.deepInclude(result.plan.skipped, {
        path: path.join(state, "statev2.sqlite"),
        reason: `the server data dir override keeps the live copy at ${dataDir} in either layout`,
      });
      assert.equal(
        yield* fs.readFileString(path.join(clientDir, "client-settings.json")),
        '{"live":true}',
      );
      assert.deepEqual(yield* fs.readDirectory(clientDir), ["client-settings.json"]);
      assert.isFalse(yield* fs.exists(configDir));
      assert.isFalse(yield* fs.exists(dataDir));
      assert.isFalse(yield* fs.exists(split("state")));
      assert.isFalse(yield* fs.exists(client("config")));
      assert.isTrue(yield* fs.exists(path.join(client("state"), "clerk-tokens.json")));
      assert.isTrue(yield* fs.exists(path.join(state, "storage-migration.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retires a legacy tree whose only trace is its caches, copying nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-migration-caches-" });
      const { input } = yield* makeFixture();
      const legacyRoots = resolveLegacyT3StorageRoots({
        baseDir: path.join(root, ".t3"),
        stateDirectoryName: "userdata",
        path,
      });
      yield* fs.makeDirectory(legacyRoots.cacheDir, { recursive: true });
      const cachesOnly = {
        ...input,
        legacyRoots,
        legacyElectronProfile: path.join(root, "missing"),
      };

      const result = yield* runStorageMigration(cachesOnly, { replaceExisting: false });

      assert.isTrue(result.migrated);
      assert.lengthOf(result.plan.entries, 0);
      assert.deepEqual(result.plan.skipped, [
        { path: legacyRoots.cacheDir, reason: `regenerated under ${input.serverRoots.cacheDir}` },
      ]);
      assert.isTrue(yield* fs.exists(path.join(legacyRoots.stateDir, "storage-migration.json")));
      assert.deepEqual(yield* fs.readDirectory(legacyRoots.cacheDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while a server still runs from the legacy tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      yield* fs.writeFileString(
        path.join(state, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
        }),
      );

      const error = yield* runStorageMigration(input, { replaceExisting: false }).pipe(Effect.flip);
      assert.instanceOf(error, StorageMigrationBlockedError);
      assert.isFalse(yield* fs.exists(split("state")));
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while the desktop app runs with the legacy profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, legacyProfile } = yield* makeFixture();
      yield* fs.remove(path.join(legacyProfile, "SingletonLock"));
      yield* fs.symlink(
        `${NodeOS.hostname()}-${String(process.pid)}`,
        path.join(legacyProfile, "SingletonLock"),
      );

      const plan = yield* planStorageMigration(input);
      assert.lengthOf(
        plan.blockers.filter((blocker) => blocker.includes("desktop app is running")),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while a background service still serves the legacy tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, input } = yield* makeFixture();
      const serviceUnitPath = path.join(root, "t3code.service");
      yield* fs.writeFileString(
        serviceUnitPath,
        `[Service]\nEnvironment=T3CODE_HOME=${input.legacyRoots.legacyBaseDir}\n`,
      );

      const plan = yield* planStorageMigration({ ...input, serviceUnitPath });
      const blocker = plan.blockers.find((entry) => entry.includes(serviceUnitPath));
      assert.include(blocker, "t3 service uninstall");

      yield* fs.writeFileString(
        serviceUnitPath,
        `[Service]\nEnvironment=T3CODE_DATA_DIR=${input.serverRoots.dataDir}\n`,
      );
      assert.isUndefined(
        (yield* planStorageMigration({ ...input, serviceUnitPath })).blockers.find((entry) =>
          entry.includes(serviceUnitPath),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves conflicting destinations aside only when asked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, split } = yield* makeFixture();
      yield* fs.makeDirectory(split("config"), { recursive: true });
      yield* fs.writeFileString(path.join(split("config"), "settings.json"), '{"stale":true}');

      const error = yield* runStorageMigration(input, { replaceExisting: false }).pipe(Effect.flip);
      assert.instanceOf(error, StorageMigrationConflictError);
      assert.isFalse(yield* fs.exists(split("state")));

      const result = yield* runStorageMigration(input, { replaceExisting: true });
      assert.lengthOf(result.replaced, 1);
      assert.equal(yield* fs.readFileString(result.replaced[0]!), '{"stale":true}');
      assert.equal(
        yield* fs.readFileString(path.join(split("config"), "settings.json")),
        '{"server":true}',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes its copies and restores what it moved aside when placing fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, selectedLayout } = yield* makeFixture();
      yield* fs.makeDirectory(path.join(split("data"), "attachments"), { recursive: true });
      yield* fs.writeFileString(path.join(split("data"), "attachments", "old.png"), "old");
      const settings = path.join(split("config"), "settings.json");
      const failingSettings = sabotage((real) => ({
        rename: (from, to) =>
          to === settings ? real.rename(`${from}.missing`, to) : real.rename(from, to),
      }));

      const error = yield* runStorageMigration(input, { replaceExisting: true }).pipe(
        Effect.provide(failingSettings),
        Effect.flip,
      );

      assert.instanceOf(error, StorageMigrationMoveError);
      assert.deepEqual(yield* fs.readDirectory(path.join(split("data"), "attachments")), [
        "old.png",
      ]);
      assert.deepEqual(yield* fs.readDirectory(split("data")), ["attachments"]);
      assert.deepEqual(yield* fs.readDirectory(split("config")), []);
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.pending.json")));
      assert.equal(selectedLayout(), "legacy");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back to the legacy tree without deleting newer data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, selectedLayout } = yield* makeFixture();
      yield* fs.makeDirectory(split("config"), { recursive: true });
      yield* fs.writeFileString(path.join(split("config"), "settings.json"), '{"stale":true}');
      yield* runStorageMigration(input, { replaceExisting: true });
      // A server that ran on the split layout may leave an uncheckpointed WAL.
      yield* fs.writeFileString(path.join(split("state"), "statev2.sqlite-wal"), "newer writes");

      const { rolledBack } = yield* rollbackStorageMigration(input);
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
      assert.equal(selectedLayout(), "legacy");
      assert.equal(
        yield* fs.readFileString(path.join(split("config"), "settings.json")),
        '{"stale":true}',
      );
      const databaseAside = rolledBack.find((aside) => aside.includes("statev2.sqlite"));
      assert.isDefined(databaseAside);
      assert.equal(yield* fs.readFileString(`${databaseAside!}-wal`), "newer writes");
      assert.isFalse(yield* fs.exists(path.join(split("state"), "statev2.sqlite-wal")));
      assert.isUndefined((yield* planStorageMigration(input)).migratedAt);

      const again = yield* rollbackStorageMigration(input);
      assert.lengthOf(again.rolledBack, 0);
      // The legacy tree can be migrated again from scratch.
      assert.isTrue((yield* runStorageMigration(input, { replaceExisting: true })).migrated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes an interrupted rollback without moving restored data aside again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      yield* fs.makeDirectory(path.join(split("data"), "attachments"), { recursive: true });
      yield* fs.writeFileString(path.join(split("data"), "attachments", "old.png"), "old");
      yield* fs.makeDirectory(split("config"), { recursive: true });
      yield* fs.writeFileString(path.join(split("config"), "settings.json"), '{"stale":true}');
      yield* runStorageMigration(input, { replaceExisting: true });
      const settings = path.join(split("config"), "settings.json");
      const failingSettings = sabotage((real) => ({
        rename: (from, to) =>
          from === settings ? Effect.die(new Error("disk went away")) : real.rename(from, to),
      }));

      const failure = yield* rollbackStorageMigration(input).pipe(
        Effect.provide(failingSettings),
        Effect.exit,
      );
      assert.isTrue(failure._tag === "Failure");
      assert.isTrue(yield* fs.exists(path.join(state, "storage-migration.json")));

      yield* rollbackStorageMigration(input);

      assert.deepEqual(yield* fs.readDirectory(path.join(split("data"), "attachments")), [
        "old.png",
      ]);
      assert.equal(yield* fs.readFileString(settings), '{"stale":true}');
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
