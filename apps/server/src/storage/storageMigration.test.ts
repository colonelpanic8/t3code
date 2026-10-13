// @effect-diagnostics nodeBuiltinImport:off - Builds real SQLite fixtures and symlinks.
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { resolveLegacyT3StorageRoots } from "@t3tools/shared/storagePaths";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  planStorageMigration,
  rollbackStorageMigration,
  runStorageMigration,
  StorageMigrationBlockedError,
  StorageMigrationConflictError,
  StorageMigrationCopyError,
  type StorageMigrationInput,
} from "./storageMigration.ts";

const DEAD_PID = 2 ** 22 + 1;

/** A legacy install with a WAL database, server and client files, and a desktop profile. */
const makeFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-migration-" });
  const legacyRoots = resolveLegacyT3StorageRoots({
    baseDir: path.join(root, "home", ".t3"),
    stateDirectoryName: "userdata",
    path,
  });
  const state = legacyRoots.stateDir;
  yield* fs.makeDirectory(path.join(state, "secrets"), { recursive: true });
  yield* fs.makeDirectory(path.join(state, "attachments"), { recursive: true });
  yield* fs.makeDirectory(path.join(state, "logs"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "home", ".t3", "worktrees"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(path.join(state, "statev2.sqlite"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('a'), ('b'), ('c')");
  database.close();
  yield* fs.writeFileString(path.join(state, "settings.json"), '{"server":true}');
  yield* fs.writeFileString(path.join(state, "environment-id"), "environment-1");
  yield* fs.writeFileString(path.join(state, "client-settings.json"), '{"client":true}');
  yield* fs.writeFileString(path.join(state, "connection-catalog.json"), '{"version":1}');
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
  const legacyProfile = path.join(root, "home", ".config", "t3code-v2");
  yield* fs.makeDirectory(path.join(legacyProfile, "Local Storage"), { recursive: true });
  yield* fs.writeFileString(path.join(legacyProfile, "Local State"), "{}");
  yield* fs.writeFileString(path.join(legacyProfile, "Local Storage", "CURRENT"), "x");
  yield* fs.symlink(
    `${NodeOS.hostname()}-${String(DEAD_PID)}`,
    path.join(legacyProfile, "SingletonLock"),
  );

  const split = (name: string) => path.join(root, "split", name);
  const client = (name: string) => path.join(root, "client", name);
  const input: StorageMigrationInput = {
    legacyRoots,
    serverRoots: {
      layout: "split",
      configDir: split("config"),
      dataDir: split("data"),
      stateDir: split("state"),
      cacheDir: split("cache"),
      runtimeDir: split("runtime"),
    },
    clientRoots: {
      configDir: client("config"),
      stateDir: client("state"),
      cacheDir: client("cache"),
    },
    legacyElectronProfiles: [legacyProfile],
    electronProfile: path.join(client("state"), "electron"),
  };
  return { root, input, state, split, client, legacyProfile };
});

const countThreads = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare("SELECT count(*) AS count FROM threads").get()?.count);
  } finally {
    database.close();
  }
};

describe("storage migration", () => {
  it.effect("copies each file to its owner's split root and retires the legacy tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, client } = yield* makeFixture();

      const plan = yield* planStorageMigration(input);
      assert.isFalse(yield* fs.exists(split("state")));
      assert.deepInclude(plan.skipped, {
        path: path.join(state, "logs"),
        reason: "log history stays in the legacy tree",
      });

      const result = yield* runStorageMigration(input, { replaceExisting: false });
      assert.isTrue(result.migrated);
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
      assert.isTrue(yield* fs.exists(path.join(split("data"), "attachments", "image.png")));
      assert.equal(
        (yield* fs.stat(path.join(split("state"), "secrets", "server-signing-key.bin"))).mode &
          0o777,
        0o600,
      );
      assert.isTrue(yield* fs.exists(path.join(input.electronProfile, "Local Storage", "CURRENT")));
      assert.isFalse(yield* fs.exists(path.join(input.electronProfile, "SingletonLock")));
      assert.isFalse(yield* fs.exists(path.join(split("state"), "logs")));
      assert.isFalse(yield* fs.exists(path.join(split("runtime"), "server-runtime.json")));
      // Sources are untouched; only the marker is added.
      assert.equal(countThreads(path.join(state, "statev2.sqlite")), 3);
      assert.isTrue(yield* fs.exists(path.join(state, "settings.json")));
      assert.isTrue(yield* fs.exists(path.join(state, "storage-migration.json")));

      const again = yield* runStorageMigration(input, { replaceExisting: false });
      assert.isFalse(again.migrated);
      assert.isDefined(again.plan.migratedAt);
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

  it.effect("removes its copies and restores what it moved aside when a copy fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split, client } = yield* makeFixture();
      yield* fs.makeDirectory(path.join(split("data"), "attachments"), { recursive: true });
      yield* fs.writeFileString(path.join(split("data"), "attachments", "old.png"), "old");
      // A file where the client config directory belongs makes the client copy fail.
      yield* fs.makeDirectory(path.dirname(client("config")), { recursive: true });
      yield* fs.writeFileString(client("config"), "not a directory");

      const error = yield* runStorageMigration(input, { replaceExisting: true }).pipe(Effect.flip);
      assert.instanceOf(error, StorageMigrationCopyError);
      assert.deepEqual(yield* fs.readDirectory(path.join(split("data"), "attachments")), [
        "old.png",
      ]);
      assert.deepEqual(yield* fs.readDirectory(split("data")), ["attachments"]);
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back to the legacy tree without deleting newer data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { input, state, split } = yield* makeFixture();
      yield* fs.makeDirectory(split("config"), { recursive: true });
      yield* fs.writeFileString(path.join(split("config"), "settings.json"), '{"stale":true}');
      yield* runStorageMigration(input, { replaceExisting: true });
      // A server that ran on the split layout may leave an uncheckpointed WAL.
      yield* fs.writeFileString(path.join(split("state"), "statev2.sqlite-wal"), "newer writes");

      const { rolledBack } = yield* rollbackStorageMigration(input);
      assert.isFalse(yield* fs.exists(path.join(state, "storage-migration.json")));
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
});
