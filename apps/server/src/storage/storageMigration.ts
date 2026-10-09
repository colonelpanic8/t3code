// @effect-diagnostics nodeBuiltinImport:off - node:sqlite snapshots and verifies databases.
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import {
  legacyT3StorageArtifactPaths,
  legacyT3StorageMigrationMarkerPath,
  type T3ClientStorageRoots,
  type T3StorageRoots,
} from "@t3tools/shared/storagePaths";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

// One-time, user-invoked copy of a legacy ~/.t3/userdata tree into the split server roots and the
// separate client roots. Sources are only ever read. Every destination entry is written under a
// temporary name and renamed into place, all of them are verified against their sources, and only
// then is the marker written into the legacy tree; the marker is what makes layout selection stop
// choosing that tree. Without it nothing the migration wrote is used.

export class StorageMigrationBlockedError extends Schema.TaggedError<StorageMigrationBlockedError>()(
  "StorageMigrationBlockedError",
  { blockers: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Storage migration cannot run:\n${this.blockers.map((blocker) => `  - ${blocker}`).join("\n")}`;
  }
}

export class StorageMigrationConflictError extends Schema.TaggedError<StorageMigrationConflictError>()(
  "StorageMigrationConflictError",
  { destinations: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These destinations already exist with different contents:\n${this.destinations.map((destination) => `  - ${destination}`).join("\n")}\nRerun with --replace-existing to move them aside first.`;
  }
}

export class StorageMigrationCopyError extends Schema.TaggedError<StorageMigrationCopyError>()(
  "StorageMigrationCopyError",
  { source: Schema.String, destination: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not copy ${this.source} to ${this.destination}. Nothing was switched over and the copies made so far were removed.`;
  }
}

export class StorageMigrationMoveError extends Schema.TaggedError<StorageMigrationMoveError>()(
  "StorageMigrationMoveError",
  { from: Schema.String, to: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not move ${this.from} to ${this.to}. The migration marker is still in place; rerun the rollback once the cause is fixed.`;
  }
}

export class StorageMigrationVerificationError extends Schema.TaggedError<StorageMigrationVerificationError>()(
  "StorageMigrationVerificationError",
  { destination: Schema.String, check: Schema.String },
) {
  override get message(): string {
    return `The copy at ${this.destination} failed verification (${this.check}). Nothing was switched over and the copies made so far were removed.`;
  }
}

export class StorageMigrationMarkerError extends Schema.TaggedError<StorageMigrationMarkerError>()(
  "StorageMigrationMarkerError",
  { markerPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the storage migration marker at ${this.markerPath}.`;
  }
}

const StorageMigrationMarker = Schema.Struct({
  version: Schema.Literal(1),
  migratedAt: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      destination: Schema.String,
      replaced: Schema.optionalKey(Schema.String),
    }),
  ),
});
type StorageMigrationMarker = typeof StorageMigrationMarker.Type;
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(StorageMigrationMarker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(StorageMigrationMarker));

export interface StorageMigrationInput {
  /** The legacy tree to copy from; `stateDir` is its userdata directory. */
  readonly legacyRoots: T3StorageRoots;
  readonly serverRoots: T3StorageRoots;
  readonly clientRoots: T3ClientStorageRoots;
  /** Candidate legacy Electron profiles, in the order the desktop selects them. */
  readonly legacyElectronProfiles: ReadonlyArray<string>;
  readonly electronProfile: string;
}

export interface StorageMigrationEntry {
  readonly owner: "server" | "client";
  readonly kind: "database" | "file" | "directory";
  readonly source: string;
  readonly destination: string;
  readonly status: "copy" | "present" | "conflict";
  readonly files: number;
  readonly bytes: number;
}

export interface StorageMigrationSkip {
  readonly path: string;
  readonly reason: string;
}

export interface StorageMigrationPlan {
  readonly input: StorageMigrationInput;
  /** Set when the legacy tree already carries the marker. */
  readonly migratedAt: string | undefined;
  readonly entries: ReadonlyArray<StorageMigrationEntry>;
  readonly skipped: ReadonlyArray<StorageMigrationSkip>;
  readonly blockers: ReadonlyArray<string>;
}

const SERVER_CONFIG_FILES = new Set([
  "settings.json",
  "keybindings.json",
  "keybindings-migrations",
]);
const SERVER_DATA_DIRECTORIES = new Set(["attachments", "browser-artifacts"]);
const CLIENT_CONFIG_FILES = new Set(["client-settings.json", "desktop-settings.json"]);
const CLIENT_STATE_FILES = new Set([
  "connection-catalog.json",
  "saved-environments.json",
  "clerk-tokens.json",
  "cli-command-path-entry",
  "snap-shots",
]);
const LEGACY_SKIPPED: Record<string, string> = {
  "server-runtime.json": "live-process state; the server rewrites it on start",
  logs: "log history stays in the legacy tree",
  "wsl-server-tree": "extracted cache; the desktop rebuilds it",
};
/** Chromium's per-run profile lock; copying it would make the copy look in use. */
const ELECTRON_EXCLUDED = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);

const databaseSidecar = /-(wal|shm|journal)$/;
const DATABASE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

/**
 * Renames `from` to `to`, carrying any SQLite sidecars along: a WAL left beside a different
 * database file would be replayed into it, and an uncheckpointed WAL holds the newest writes.
 */
const moveWithSidecars = Effect.fn("storageMigration.moveWithSidecars")(function* (
  from: string,
  to: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const moved = yield* fs.exists(from);
  if (moved) yield* fs.rename(from, to);
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    if (yield* fs.exists(`${from}${suffix}`))
      yield* fs.rename(`${from}${suffix}`, `${to}${suffix}`);
  }
  return moved;
});

const anyExists = Effect.fn("storageMigration.anyExists")(function* (paths: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  for (const candidate of paths) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return true;
  }
  return false;
});

interface WalkedFile {
  readonly relativePath: string;
  readonly size: number;
}

/** Regular files and symlinks under `root`, skipping `exclude` at the top level. */
const walk = Effect.fn("storageMigration.walk")(function* (
  root: string,
  exclude: ReadonlySet<string> = new Set(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<WalkedFile> = [];
  const visit = (relativeDirectory: string): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const names = yield* fs
        .readDirectory(path.join(root, relativeDirectory))
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      for (const name of names.toSorted()) {
        if (relativeDirectory === "" && exclude.has(name)) continue;
        const relativePath = relativeDirectory === "" ? name : path.join(relativeDirectory, name);
        const absolutePath = path.join(root, relativePath);
        if (Option.isSome(yield* fs.readLink(absolutePath).pipe(Effect.option))) {
          files.push({ relativePath, size: 0 });
          continue;
        }
        const info = yield* fs.stat(absolutePath).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          yield* visit(relativePath);
        } else if (info.value.type === "File") {
          files.push({ relativePath, size: Number(info.value.size) });
        }
      }
    });
  yield* visit("");
  return files;
});

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const sameFile = Effect.fn("storageMigration.sameFile")(function* (left: string, right: string) {
  const fs = yield* FileSystem.FileSystem;
  const leftLink = yield* fs.readLink(left).pipe(Effect.option);
  const rightLink = yield* fs.readLink(right).pipe(Effect.option);
  if (Option.isSome(leftLink) || Option.isSome(rightLink)) {
    return Option.getOrUndefined(leftLink) === Option.getOrUndefined(rightLink);
  }
  const [leftBytes, rightBytes] = yield* Effect.all([
    fs.readFile(left).pipe(Effect.option),
    fs.readFile(right).pipe(Effect.option),
  ]);
  return (
    Option.isSome(leftBytes) &&
    Option.isSome(rightBytes) &&
    sameBytes(leftBytes.value, rightBytes.value)
  );
});

/** The first file that differs between the trees, or undefined when they match. */
const firstDifference = Effect.fn("storageMigration.firstDifference")(function* (
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
    if (
      !(yield* sameFile(
        path.join(source, file.relativePath),
        path.join(destination, file.relativePath),
      ))
    ) {
      return file.relativePath;
    }
  }
  return undefined;
});

class StorageMigrationDatabaseError extends Schema.TaggedError<StorageMigrationDatabaseError>()(
  "StorageMigrationDatabaseError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the database at ${this.databasePath}.`;
  }
}

const tryDatabase = <A>(databasePath: string, use: (database: NodeSqlite.DatabaseSync) => A) =>
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
const databaseFingerprint = (databasePath: string) =>
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

const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const timestampSuffix = (now: DateTime.Utc) =>
  DateTime.formatIso(now)
    .replaceAll(":", "")
    .replace(/\.\d+Z$/, "Z");

const liveServerBlocker = Effect.fn("storageMigration.liveServerBlocker")(function* (
  runtimeStatePath: string,
) {
  const state = yield* readPersistedServerRuntimeState(runtimeStatePath).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(state) || state.value.pid <= 0 || !isProcessAlive(state.value.pid)) {
    return undefined;
  }
  return `A T3 Code server is running from this storage (pid ${String(state.value.pid)}, ${state.value.origin}, ${runtimeStatePath}). Stop it first.`;
});

const runningDesktopBlocker = Effect.fn("storageMigration.runningDesktopBlocker")(function* (
  profile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* fs.readLink(path.join(profile, "SingletonLock")).pipe(Effect.option);
  if (Option.isNone(lock)) return undefined;
  const separator = lock.value.lastIndexOf("-");
  const host = lock.value.slice(0, separator);
  const pid = Number(lock.value.slice(separator + 1));
  if (host !== NodeOS.hostname() || !Number.isInteger(pid) || !isProcessAlive(pid)) {
    return undefined;
  }
  return `The T3 Code desktop app is running with the profile at ${profile} (pid ${String(pid)}). Quit it first.`;
});

const readMarker = Effect.fn("storageMigration.readMarker")(function* (markerPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(markerPath).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<StorageMigrationMarker>();
  return Option.some(
    yield* decodeMarker(raw.value).pipe(
      Effect.mapError((cause) => new StorageMigrationMarkerError({ markerPath, cause })),
    ),
  );
});

/** Decides what goes where without writing anything. */
export const planStorageMigration = Effect.fn("storageMigration.plan")(function* (
  input: StorageMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { clientRoots, legacyRoots, serverRoots } = input;
  const legacyStateDir = legacyRoots.stateDir;
  const marker = yield* readMarker(legacyT3StorageMigrationMarkerPath(legacyRoots, path));
  const blockers: Array<string> = [];
  const skipped: Array<StorageMigrationSkip> = [];
  const sources: Array<Omit<StorageMigrationEntry, "status" | "files" | "bytes">> = [];

  const initialized = (yield* Effect.forEach(
    legacyT3StorageArtifactPaths(legacyRoots, path),
    (artifact) => fs.exists(artifact).pipe(Effect.orElseSucceed(() => false)),
  )).some(Boolean);
  if (!initialized) {
    blockers.push(`${legacyStateDir} holds no T3 Code installation to migrate.`);
  }

  const names = yield* fs
    .readDirectory(legacyStateDir)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const hasV2Database = names.includes("statev2.sqlite");
  for (const name of names.toSorted()) {
    const source = path.join(legacyStateDir, name);
    const skipReason =
      LEGACY_SKIPPED[name] ??
      (name === path.basename(legacyT3StorageMigrationMarkerPath(legacyRoots, path))
        ? "migration marker"
        : databaseSidecar.test(name)
          ? "folded into the database snapshot"
          : name.startsWith(".")
            ? "temporary file"
            : name === "state.sqlite" && hasV2Database
              ? "superseded; statev2.sqlite already holds its tables"
              : undefined);
    if (skipReason !== undefined) {
      skipped.push({ path: source, reason: skipReason });
      continue;
    }
    const info = yield* fs.stat(source).pipe(Effect.option);
    if (Option.isNone(info)) continue;
    const kind = name.endsWith(".sqlite")
      ? ("database" as const)
      : info.value.type === "Directory"
        ? ("directory" as const)
        : ("file" as const);
    const [owner, root] = CLIENT_CONFIG_FILES.has(name)
      ? (["client", clientRoots.configDir] as const)
      : CLIENT_STATE_FILES.has(name)
        ? (["client", clientRoots.stateDir] as const)
        : SERVER_CONFIG_FILES.has(name)
          ? (["server", serverRoots.configDir] as const)
          : SERVER_DATA_DIRECTORIES.has(name)
            ? (["server", serverRoots.dataDir] as const)
            : (["server", serverRoots.stateDir] as const);
    sources.push({ owner, kind, source, destination: path.join(root, name) });
  }

  for (const profile of input.legacyElectronProfiles) {
    if (!(yield* fs.exists(profile).pipe(Effect.orElseSucceed(() => false)))) continue;
    sources.push({
      owner: "client",
      kind: "directory",
      source: profile,
      destination: input.electronProfile,
    });
    const desktop = yield* runningDesktopBlocker(profile);
    if (desktop !== undefined) blockers.push(desktop);
    break;
  }
  const splitDesktop = yield* runningDesktopBlocker(input.electronProfile);
  if (splitDesktop !== undefined) blockers.push(splitDesktop);

  if (legacyRoots.legacyBaseDir !== undefined) {
    const siblings = yield* fs
      .readDirectory(legacyRoots.legacyBaseDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const name of siblings.toSorted()) {
      const sibling = path.join(legacyRoots.legacyBaseDir, name);
      if (sibling === legacyStateDir) continue;
      skipped.push({
        path: sibling,
        reason:
          name === "worktrees"
            ? `threads reference these worktrees by path; new worktrees go to ${path.join(serverRoots.dataDir, "worktrees")}`
            : name === "caches"
              ? `regenerated under ${serverRoots.cacheDir}`
              : "not part of the userdata tree; left in place",
      });
    }
  }

  for (const runtimeStatePath of [
    path.join(legacyStateDir, "server-runtime.json"),
    path.join(serverRoots.runtimeDir, "server-runtime.json"),
  ]) {
    const server = yield* liveServerBlocker(runtimeStatePath);
    if (server !== undefined) blockers.push(server);
  }

  const entries: Array<StorageMigrationEntry> = [];
  for (const entry of sources) {
    const exclude =
      entry.destination === input.electronProfile ? ELECTRON_EXCLUDED : new Set<string>();
    const files =
      entry.kind === "directory"
        ? yield* walk(entry.source, exclude)
        : [{ relativePath: "", size: Number((yield* fs.stat(entry.source)).size) }];
    const exists = yield* anyExists(
      entry.kind === "database"
        ? [
            entry.destination,
            ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${entry.destination}${suffix}`),
          ]
        : [entry.destination],
    );
    const status: StorageMigrationEntry["status"] = !exists
      ? "copy"
      : entry.kind === "database"
        ? "conflict"
        : entry.kind === "file"
          ? (yield* sameFile(entry.source, entry.destination))
            ? "present"
            : "conflict"
          : (yield* firstDifference(entry.source, entry.destination, exclude)) === undefined
            ? "present"
            : "conflict";
    entries.push({
      ...entry,
      status,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
    });
  }

  return {
    input,
    migratedAt: Option.getOrUndefined(Option.map(marker, (value) => value.migratedAt)),
    entries,
    skipped,
    blockers,
  } satisfies StorageMigrationPlan;
});

/** Copies one entry under a temporary sibling name, then renames it into place. */
const copyEntry = Effect.fn("storageMigration.copyEntry")(function* (
  entry: StorageMigrationEntry,
  exclude: ReadonlySet<string>,
  suffix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = `${entry.destination}.migrating-${suffix}`;
  const parent = path.dirname(entry.destination);
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    if (entry.kind === "database") {
      yield* tryDatabase(entry.source, (database) =>
        database.exec(`VACUUM INTO ${quoteSqlString(temporary)}`),
      );
      yield* fs.chmod(temporary, 0o600);
    } else if (entry.kind === "file") {
      yield* fs.copyFile(entry.source, temporary);
      yield* fs.chmod(temporary, (yield* fs.stat(entry.source)).mode & 0o777);
    } else {
      yield* fs.makeDirectory(temporary, { mode: (yield* fs.stat(entry.source)).mode & 0o777 });
      for (const file of yield* walk(entry.source, exclude)) {
        const from = path.join(entry.source, file.relativePath);
        const to = path.join(temporary, file.relativePath);
        let directory = path.dirname(file.relativePath);
        const missing: Array<string> = [];
        while (directory !== "." && !(yield* fs.exists(path.join(temporary, directory)))) {
          missing.unshift(directory);
          directory = path.dirname(directory);
        }
        for (const relativeDirectory of missing) {
          const mode = (yield* fs.stat(path.join(entry.source, relativeDirectory))).mode & 0o777;
          yield* fs.makeDirectory(path.join(temporary, relativeDirectory), { mode });
        }
        const link = yield* fs.readLink(from).pipe(Effect.option);
        if (Option.isSome(link)) {
          yield* fs.symlink(link.value, to);
        } else {
          yield* fs.copyFile(from, to);
          yield* fs.chmod(to, (yield* fs.stat(from)).mode & 0o777);
        }
      }
    }
    yield* fs.rename(temporary, entry.destination);
  }).pipe(
    Effect.onError(() =>
      fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
    Effect.mapError(
      (cause) =>
        new StorageMigrationCopyError({
          source: entry.source,
          destination: entry.destination,
          cause,
        }),
    ),
  );
});

const verifyEntry = Effect.fn("storageMigration.verifyEntry")(function* (
  entry: StorageMigrationEntry,
  exclude: ReadonlySet<string>,
) {
  const fail = (check: string) =>
    new StorageMigrationVerificationError({ destination: entry.destination, check });
  if (entry.kind === "database") {
    const integrity = yield* tryDatabase(entry.destination, (database) =>
      String(database.prepare("PRAGMA integrity_check").get()?.integrity_check),
    ).pipe(Effect.mapError(() => fail("could not open the copy")));
    if (integrity !== "ok") return yield* fail(`integrity_check: ${integrity}`);
    const [source, copy] = yield* Effect.all([
      databaseFingerprint(entry.source),
      databaseFingerprint(entry.destination),
    ]).pipe(Effect.mapError(() => fail("could not count rows")));
    if (source !== copy) return yield* fail("row counts differ from the source");
    return;
  }
  if (entry.kind === "file") {
    if (!(yield* sameFile(entry.source, entry.destination))) {
      return yield* fail("contents differ from the source");
    }
    return;
  }
  const difference = yield* firstDifference(entry.source, entry.destination, exclude);
  if (difference !== undefined) return yield* fail(`${difference} differs from the source`);
});

/**
 * Copies, verifies, then marks the legacy tree as migrated. A rerun after success is a no-op;
 * a failure removes what this run wrote and restores anything it moved aside.
 */
export const runStorageMigration = Effect.fn("storageMigration.run")(function* (
  input: StorageMigrationInput,
  options: { readonly replaceExisting: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plan = yield* planStorageMigration(input);
  if (plan.migratedAt !== undefined) return { plan, migrated: false, replaced: [] } as const;
  if (plan.blockers.length > 0) {
    return yield* new StorageMigrationBlockedError({ blockers: plan.blockers });
  }
  const conflicts = plan.entries.filter((entry) => entry.status === "conflict");
  if (conflicts.length > 0 && !options.replaceExisting) {
    return yield* new StorageMigrationConflictError({
      destinations: conflicts.map((entry) => entry.destination),
    });
  }

  const now = yield* DateTime.now;
  const suffix = timestampSuffix(now);
  type MarkerEntry = StorageMigrationMarker["entries"][number];
  const markerEntries: Array<MarkerEntry> = [];
  // Only what this run wrote; a destination that already matched is not ours to remove.
  const writtenByThisRun: Array<MarkerEntry> = [];
  const undo = Effect.suspend(() =>
    Effect.forEach(
      writtenByThisRun.toReversed(),
      (entry) =>
        Effect.gen(function* () {
          yield* fs.remove(entry.destination, { recursive: true, force: true });
          if (entry.replaced !== undefined)
            yield* moveWithSidecars(entry.replaced, entry.destination);
        }).pipe(Effect.ignore),
      { discard: true },
    ),
  );

  yield* Effect.gen(function* () {
    for (const entry of plan.entries) {
      const exclude =
        entry.destination === input.electronProfile ? ELECTRON_EXCLUDED : new Set<string>();
      if (entry.status === "present") {
        markerEntries.push({ source: entry.source, destination: entry.destination });
        continue;
      }
      const written: MarkerEntry =
        entry.status === "conflict"
          ? {
              source: entry.source,
              destination: entry.destination,
              replaced: `${entry.destination}.pre-migration-${suffix}`,
            }
          : { source: entry.source, destination: entry.destination };
      if (written.replaced !== undefined) {
        yield* moveWithSidecars(entry.destination, written.replaced).pipe(
          Effect.mapError(
            (cause) =>
              new StorageMigrationCopyError({
                source: entry.source,
                destination: entry.destination,
                cause,
              }),
          ),
        );
        writtenByThisRun.push(written);
        yield* copyEntry(entry, exclude, suffix);
      } else {
        yield* copyEntry(entry, exclude, suffix);
        writtenByThisRun.push(written);
      }
      markerEntries.push(written);
    }
    for (const entry of plan.entries) {
      yield* verifyEntry(
        entry,
        entry.destination === input.electronProfile ? ELECTRON_EXCLUDED : new Set<string>(),
      );
    }
    const marker = yield* encodeMarker({
      version: 1,
      migratedAt: DateTime.formatIso(now),
      entries: markerEntries,
    });
    yield* writeFileStringAtomically({
      filePath: legacyT3StorageMigrationMarkerPath(input.legacyRoots, path),
      contents: `${marker}\n`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StorageMigrationMarkerError({
            markerPath: legacyT3StorageMigrationMarkerPath(input.legacyRoots, path),
            cause,
          }),
      ),
    );
  }).pipe(Effect.onError(() => undo));

  return {
    plan,
    migrated: true,
    replaced: markerEntries.flatMap((entry) =>
      entry.replaced === undefined ? [] : [entry.replaced],
    ),
  } as const;
});

/**
 * Returns to the legacy tree: each copy the migration placed is renamed aside (never deleted, so
 * anything written since survives), anything it replaced is restored, and the marker is removed.
 */
export const rollbackStorageMigration = Effect.fn("storageMigration.rollback")(function* (
  input: StorageMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = legacyT3StorageMigrationMarkerPath(input.legacyRoots, path);
  const marker = yield* readMarker(markerPath);
  if (Option.isNone(marker)) return { rolledBack: [] as ReadonlyArray<string> };

  const blockers: Array<string> = [];
  for (const runtimeStatePath of [
    path.join(input.legacyRoots.stateDir, "server-runtime.json"),
    path.join(input.serverRoots.runtimeDir, "server-runtime.json"),
  ]) {
    const server = yield* liveServerBlocker(runtimeStatePath);
    if (server !== undefined) blockers.push(server);
  }
  const desktop = yield* runningDesktopBlocker(input.electronProfile);
  if (desktop !== undefined) blockers.push(desktop);
  if (blockers.length > 0) return yield* new StorageMigrationBlockedError({ blockers });

  const suffix = timestampSuffix(yield* DateTime.now);
  const rolledBack: Array<string> = [];
  for (const entry of marker.value.entries) {
    yield* Effect.gen(function* () {
      const aside = `${entry.destination}.rolled-back-${suffix}`;
      if (yield* moveWithSidecars(entry.destination, aside)) rolledBack.push(aside);
      if (entry.replaced !== undefined) yield* moveWithSidecars(entry.replaced, entry.destination);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StorageMigrationMoveError({
            from: entry.destination,
            to: `${entry.destination}.rolled-back-${suffix}`,
            cause,
          }),
      ),
    );
  }
  yield* fs.remove(markerPath);
  return { rolledBack };
});
