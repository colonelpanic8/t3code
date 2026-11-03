// @effect-diagnostics nodeBuiltinImport:off - node:sqlite snapshots databases; files are compared in streamed chunks.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// The filesystem primitives `t3 storage migrate` builds on. None of them
// overwrites an existing path, and every read failure is an error rather than
// an empty answer, so a copy is never declared complete while part of its
// source could not be read.

export class StorageMigrationReadError extends Schema.TaggedError<StorageMigrationReadError>()(
  "StorageMigrationReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.path}, so the migration cannot tell whether its copy is complete.`;
  }
}

export class StorageMigrationOccupiedError extends Schema.TaggedError<StorageMigrationOccupiedError>()(
  "StorageMigrationOccupiedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} already exists; the migration never overwrites a file.`;
  }
}

export class StorageMigrationDatabaseError extends Schema.TaggedError<StorageMigrationDatabaseError>()(
  "StorageMigrationDatabaseError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the database at ${this.databasePath}.`;
  }
}

export const DATABASE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export const pathExists = Effect.fn("storageMigration.pathExists")(function* (candidate: string) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(candidate).pipe(Effect.option);
  if (Option.isSome(link)) return true;
  return yield* fs
    .exists(candidate)
    .pipe(Effect.mapError((cause) => new StorageMigrationReadError({ path: candidate, cause })));
});

/**
 * Renames `from` to `to` with any SQLite sidecars: a WAL left beside another
 * database would be replayed into it, and an uncheckpointed WAL holds the
 * newest writes. Refuses when a target exists, since rename would replace it.
 */
export const moveWithSidecars = Effect.fn("storageMigration.moveWithSidecars")(function* (
  from: string,
  to: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const moves = ["", ...DATABASE_SIDECAR_SUFFIXES].map((suffix) => ({
    from: `${from}${suffix}`,
    to: `${to}${suffix}`,
  }));
  const present: Array<{ readonly from: string; readonly to: string }> = [];
  for (const move of moves) {
    if (!(yield* pathExists(move.from))) continue;
    if (yield* pathExists(move.to))
      return yield* new StorageMigrationOccupiedError({ path: move.to });
    present.push(move);
  }
  for (const move of present) yield* fs.rename(move.from, move.to);
  return present.some((move) => move.from === from);
});

export const removeWithSidecars = Effect.fn("storageMigration.removeWithSidecars")(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", ...DATABASE_SIDECAR_SUFFIXES]) {
    yield* fs.remove(`${target}${suffix}`, { recursive: true, force: true });
  }
});

export interface WalkedFile {
  readonly relativePath: string;
  readonly size: number;
}

/** Regular files and symlinks under `root`, skipping `exclude` at the top level. */
export const walk = Effect.fn("storageMigration.walk")(function* (
  root: string,
  exclude: ReadonlySet<string> = new Set(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<WalkedFile> = [];
  const visit: (relativeDirectory: string) => Effect.Effect<void, StorageMigrationReadError> =
    Effect.fn("storageMigration.visit")(function* (relativeDirectory: string) {
      const directory = path.join(root, relativeDirectory);
      const names = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.mapError((cause) => new StorageMigrationReadError({ path: directory, cause })),
        );
      for (const name of names.toSorted()) {
        if (relativeDirectory === "" && exclude.has(name)) continue;
        const relativePath = relativeDirectory === "" ? name : path.join(relativeDirectory, name);
        const absolutePath = path.join(root, relativePath);
        if (Option.isSome(yield* fs.readLink(absolutePath).pipe(Effect.option))) {
          files.push({ relativePath, size: 0 });
          continue;
        }
        const info = yield* fs
          .stat(absolutePath)
          .pipe(
            Effect.mapError(
              (cause) => new StorageMigrationReadError({ path: absolutePath, cause }),
            ),
          );
        if (info.type === "Directory") {
          yield* visit(relativePath);
        } else if (info.type === "File") {
          files.push({ relativePath, size: Number(info.size) });
        }
      }
    });
  yield* visit("");
  return files;
});

const COMPARE_CHUNK_BYTES = 1024 * 1024;

/** Byte-for-byte equality, read in chunks so neither file has to fit in memory. */
const sameContents = (left: string, right: string) =>
  Effect.tryPromise({
    try: async () => {
      const leftHandle = await NodeFSP.open(left, "r");
      try {
        const rightHandle = await NodeFSP.open(right, "r");
        try {
          const [leftInfo, rightInfo] = await Promise.all([leftHandle.stat(), rightHandle.stat()]);
          if (leftInfo.size !== rightInfo.size) return false;
          const leftBuffer = Buffer.alloc(COMPARE_CHUNK_BYTES);
          const rightBuffer = Buffer.alloc(COMPARE_CHUNK_BYTES);
          for (let position = 0; ;) {
            const [leftRead, rightRead] = await Promise.all([
              leftHandle.read(leftBuffer, 0, COMPARE_CHUNK_BYTES, position),
              rightHandle.read(rightBuffer, 0, COMPARE_CHUNK_BYTES, position),
            ]);
            if (leftRead.bytesRead !== rightRead.bytesRead) return false;
            if (leftRead.bytesRead === 0) return true;
            if (
              !leftBuffer
                .subarray(0, leftRead.bytesRead)
                .equals(rightBuffer.subarray(0, rightRead.bytesRead))
            ) {
              return false;
            }
            position += leftRead.bytesRead;
          }
        } finally {
          await rightHandle.close();
        }
      } finally {
        await leftHandle.close();
      }
    },
    catch: (cause) => new StorageMigrationReadError({ path: `${left} or ${right}`, cause }),
  });

/** Whether two paths hold the same file: the same link target, or the same bytes. */
export const sameFile = Effect.fn("storageMigration.sameFile")(function* (
  left: string,
  right: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const leftLink = yield* fs.readLink(left).pipe(Effect.option);
  const rightLink = yield* fs.readLink(right).pipe(Effect.option);
  if (Option.isSome(leftLink) || Option.isSome(rightLink)) {
    return Option.getOrUndefined(leftLink) === Option.getOrUndefined(rightLink);
  }
  return yield* sameContents(left, right);
});

/** The first file that differs between the trees, or undefined when they match. */
export const firstDifference = Effect.fn("storageMigration.firstDifference")(function* (
  source: string,
  destination: string,
  exclude: ReadonlySet<string>,
) {
  const path = yield* Path.Path;
  const sourceFiles = yield* walk(source, exclude);
  const destinationFiles = yield* walk(destination, exclude);
  const destinationPaths = new Set(destinationFiles.map((file) => file.relativePath));
  if (sourceFiles.length !== destinationFiles.length) return "file count";
  for (const file of sourceFiles) {
    if (!destinationPaths.has(file.relativePath)) return file.relativePath;
    const same = yield* sameFile(
      path.join(source, file.relativePath),
      path.join(destination, file.relativePath),
    );
    if (!same) return file.relativePath;
  }
  return undefined;
});

/** A symlink's target as an absolute path, so a recreated link resolves to the same place. */
export const absoluteLinkTarget = Effect.fn("storageMigration.absoluteLinkTarget")(function* (
  link: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* fs.readLink(link).pipe(Effect.option);
  return Option.map(target, (value) => path.resolve(path.dirname(link), value));
});

export const tryDatabase = <A>(
  databasePath: string,
  use: (database: NodeSqlite.DatabaseSync) => A,
) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        return use(database);
      } finally {
        database.close();
      }
    },
    catch: (cause) => new StorageMigrationDatabaseError({ databasePath, cause }),
  });

/** Row counts per table and the schema version, the facts a snapshot must reproduce. */
export const databaseFingerprint = (databasePath: string) =>
  tryDatabase(databasePath, (database) => {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const counts = tables.map((table) => {
      const row = database
        .prepare(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`)
        .get();
      return `${table}=${String(row?.count)}`;
    });
    const userVersion = database.prepare("PRAGMA user_version").get();
    return `${counts.join(",")};user_version=${String(userVersion?.user_version)}`;
  });

export const snapshotDatabase = (source: string, destination: string) =>
  tryDatabase(source, (database) =>
    database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`),
  );

/** Copies the tree under `source` to the new directory `destination`, keeping modes and links. */
export const copyTree = Effect.fn("storageMigration.copyTree")(function* (
  source: string,
  destination: string,
  exclude: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(destination, { mode: (yield* fs.stat(source)).mode & 0o777 });
  for (const file of yield* walk(source, exclude)) {
    const from = path.join(source, file.relativePath);
    const to = path.join(destination, file.relativePath);
    let directory = path.dirname(file.relativePath);
    const missing: Array<string> = [];
    while (directory !== "." && !(yield* fs.exists(path.join(destination, directory)))) {
      missing.unshift(directory);
      directory = path.dirname(directory);
    }
    for (const relativeDirectory of missing) {
      const mode = (yield* fs.stat(path.join(source, relativeDirectory))).mode & 0o777;
      yield* fs.makeDirectory(path.join(destination, relativeDirectory), { mode });
    }
    const link = yield* fs.readLink(from).pipe(Effect.option);
    if (Option.isSome(link)) {
      yield* fs.symlink(link.value, to);
    } else {
      yield* fs.copyFile(from, to);
      yield* fs.chmod(to, (yield* fs.stat(from)).mode & 0o777);
    }
  }
});
