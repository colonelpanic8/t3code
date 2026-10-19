// @effect-diagnostics nodeBuiltinImport:off - names temporary copies with random suffixes.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  LEGACY_STORAGE_MIGRATION_JOURNAL,
  LEGACY_STORAGE_MIGRATION_MARKER,
  legacyT3StorageArtifactPaths,
  legacyT3StorageMigrationJournalPath,
  legacyT3StorageMigrationMarkerPath,
  type T3ClientStorageRoots,
  type T3LegacyStorageRoots,
  type T3SplitStorageRoots,
} from "@t3tools/shared/storagePaths";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { bootServiceBaseDirOf } from "../cloud/bootService.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  absoluteLinkTarget,
  copyTree,
  DATABASE_SIDECAR_SUFFIXES,
  databaseFingerprint,
  firstDifference,
  moveWithSidecars,
  pathExists,
  removeWithSidecars,
  sameFile,
  snapshotDatabase,
  tryDatabase,
  walk,
} from "./storageMigrationFiles.ts";

// One-time, user-invoked copy of a legacy ~/.t3/userdata tree into the split
// server roots and the separate client roots. Sources are only ever read.
//
// A run stages every copy under a temporary name beside its destination and
// verifies it there, so nothing the app reads changes until every copy is
// known good. It then writes a journal into the legacy tree, renames the copies
// into place with the files that mark a split install last, writes the marker,
// and removes the journal. Selection keeps the legacy tree while the journal
// exists, so a run killed at any point leaves the app on ~/.t3, and the next
// run or rollback undoes what the journal names before doing anything else.
//
// Files that a location override or client dir keeps elsewhere in either
// layout are left alone: the live copy is already where the migrated app reads.

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
    return `Could not move ${this.from} to ${this.to}. Rerun the command once the cause is fixed; it picks up where this one stopped.`;
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
    return `Could not read or write the storage migration record at ${this.markerPath}.`;
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
      /** Already held these contents before the migration, so rollback leaves it. */
      preexisting: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type StorageMigrationMarker = typeof StorageMigrationMarker.Type;
type MarkerEntry = StorageMigrationMarker["entries"][number];
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(StorageMigrationMarker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(StorageMigrationMarker));

const StorageMigrationJournal = Schema.Struct({
  version: Schema.Literal(1),
  startedAt: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      destination: Schema.String,
      staged: Schema.String,
      replaced: Schema.optionalKey(Schema.String),
    }),
  ),
});
type StorageMigrationJournal = typeof StorageMigrationJournal.Type;
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(StorageMigrationJournal));
const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(StorageMigrationJournal));

export interface StorageMigrationInput {
  /** The legacy tree to copy from; `stateDir` is its userdata directory. */
  readonly legacyRoots: T3LegacyStorageRoots;
  readonly serverRoots: T3SplitStorageRoots;
  readonly clientRoots: T3ClientStorageRoots;
  /** Server location overrides, which win over the layout's directories in both layouts. */
  readonly serverOverrides: {
    readonly configDir?: string | undefined;
    readonly dataDir?: string | undefined;
    readonly configFile?: string | undefined;
  };
  /** Holds the desktop's settings and small state files in both layouts. */
  readonly clientDir?: string | undefined;
  /** The legacy desktop's Electron profile; see DesktopUserData.resolveUserDataPath. */
  readonly legacyElectronProfile: string;
  readonly electronProfile: string;
  /** This host's background service unit, installed or not. */
  readonly serviceUnitPath?: string | undefined;
}

export interface StorageMigrationEntry {
  readonly owner: "server" | "client";
  readonly kind: "database" | "file" | "directory" | "symlink";
  readonly source: string;
  readonly destination: string;
  /** For a symlink: the absolute path the recreated link resolves to. */
  readonly linkTarget?: string;
  /** For a symlink: what the recreated link holds, relative when the original was. */
  readonly linkValue?: string;
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
  /** Set when a run was killed while placing its copies; the next run undoes it first. */
  readonly interruptedAt: string | undefined;
  readonly entries: ReadonlyArray<StorageMigrationEntry>;
  readonly skipped: ReadonlyArray<StorageMigrationSkip>;
  readonly blockers: ReadonlyArray<string>;
}

const SERVER_CONFIG_FILES = new Set([
  "settings.json",
  "keybindings.json",
  "keybindings-migrations",
  "server.json",
  "themes",
]);
const SERVER_DATA_DIRECTORIES = new Set(["attachments", "browser-artifacts"]);
/** The desktop's own files, which a client dir relocates. */
const CLIENT_CONFIG_FILES = new Set(["client-settings.json", "desktop-settings.json"]);
const CLIENT_STATE_FILES = new Set([
  "connection-catalog.json",
  "saved-environments.json",
  "desktop-window-state.json",
]);
/** Client files that stay in the client state root even with a client dir. */
const CLIENT_ROOT_STATE_FILES = new Set([
  "clerk-tokens.json",
  "cli-command-path-entry",
  "snap-shots",
]);
/** What makes selection treat the split layout as installed; placed last. */
const SPLIT_INSTALL_MARKERS = new Set(["statev2.sqlite", "environment-id", "secrets"]);
const LAUNCHER_SKIP_REASON =
  "the desktop's t3 launcher, which pins this tree; the desktop writes a new one and points the t3 command at it";
const MIGRATION_LOCK = "storage-migration.lock";
/** writeFileStringAtomically stages a record in a `<name>.XXXXXX` directory beside it. */
const isRecordLeftover = (name: string) =>
  name.startsWith(`${LEGACY_STORAGE_MIGRATION_MARKER}.`) ||
  name.startsWith(`${LEGACY_STORAGE_MIGRATION_JOURNAL}.`);
const LEGACY_SKIPPED: Record<string, string> = {
  "server-runtime.json": "live-process state; the server rewrites it on start",
  logs: "log history stays in the legacy tree",
  "wsl-server-tree": "extracted cache; the desktop rebuilds it",
  bin: LAUNCHER_SKIP_REASON,
  [LEGACY_STORAGE_MIGRATION_MARKER]: "migration record",
  [LEGACY_STORAGE_MIGRATION_JOURNAL]: "migration record",
  [MIGRATION_LOCK]: "migration lock",
};
/** Chromium's per-run locks, and caches it rebuilds. A copied lock would make the copy look in use. */
const ELECTRON_EXCLUDED = new Set([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "component_crx_cache",
]);
const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

const databaseSidecar = /-(wal|shm|journal)$/;

type StorageMigrationRoute =
  | { readonly owner: StorageMigrationEntry["owner"]; readonly root: string }
  | { readonly skipReason: string };

/** Where a userdata entry goes, or why it stays behind. */
const routeLegacyEntry = (
  name: string,
  tree: { readonly hasV2Database: boolean },
  input: StorageMigrationInput,
): StorageMigrationRoute => {
  const { clientDir, clientRoots, serverOverrides, serverRoots } = input;
  const fixedSkipReason =
    LEGACY_SKIPPED[name] ??
    (name.startsWith(".")
      ? "temporary file"
      : isRecordLeftover(name)
        ? "left by an interrupted migration record write; removed by the next run"
        : undefined);
  if (fixedSkipReason !== undefined) return { skipReason: fixedSkipReason };
  // An override holds the live copy in either layout, so the migrated app already reads it there.
  const liveElsewhere = (location: string, control: string) => ({
    skipReason: `${control} keeps the live copy at ${location} in either layout`,
  });
  if (CLIENT_CONFIG_FILES.has(name) || CLIENT_STATE_FILES.has(name)) {
    if (clientDir !== undefined) return liveElsewhere(clientDir, "the client dir");
    return {
      owner: "client",
      root: CLIENT_CONFIG_FILES.has(name) ? clientRoots.configDir : clientRoots.stateDir,
    };
  }
  if (CLIENT_ROOT_STATE_FILES.has(name)) return { owner: "client", root: clientRoots.stateDir };
  if (name === "server.json" && serverOverrides.configFile !== undefined) {
    return liveElsewhere(serverOverrides.configFile, "the server config file override");
  }
  if (SERVER_CONFIG_FILES.has(name)) {
    return serverOverrides.configDir === undefined
      ? { owner: "server", root: serverRoots.configDir }
      : liveElsewhere(serverOverrides.configDir, "the server config dir override");
  }
  if (serverOverrides.dataDir !== undefined) {
    return liveElsewhere(serverOverrides.dataDir, "the server data dir override");
  }
  if (databaseSidecar.test(name)) return { skipReason: "folded into the database snapshot" };
  if (name === "state.sqlite" && tree.hasV2Database) {
    return { skipReason: "superseded; statev2.sqlite already holds its tables" };
  }
  return {
    owner: "server",
    root: SERVER_DATA_DIRECTORIES.has(name) ? serverRoots.dataDir : serverRoots.stateDir,
  };
};

/** Runtime files a server on either side of the migration would write. */
const runtimeStatePaths = (input: StorageMigrationInput, path: Path.Path) => [
  path.join(input.legacyRoots.stateDir, "server-runtime.json"),
  path.join(input.serverRoots.runtimeDir, "server-runtime.json"),
  ...(input.serverOverrides.dataDir === undefined
    ? []
    : [path.join(input.serverOverrides.dataDir, "server-runtime.json")]),
];

const excludedFor = (input: StorageMigrationInput, destination: string) =>
  destination === input.electronProfile ? ELECTRON_EXCLUDED : NO_EXCLUSIONS;

const timestampSuffix = (now: DateTime.Utc) =>
  DateTime.formatIso(now)
    .replaceAll(":", "")
    .replace(/\.\d+Z$/, "Z");

/** A suffix no earlier run used, so an aside or staged name never lands on an existing one. */
const uniqueSuffix = (now: DateTime.Utc) =>
  `${timestampSuffix(now)}-${NodeCrypto.randomBytes(4).toString("hex")}`;

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

/**
 * A background service keeps serving the tree its unit names and would
 * restart against it forever once the migration or rollback retires it.
 */
const serviceBlocker = Effect.fn("storageMigration.serviceBlocker")(function* (
  input: StorageMigrationInput,
  retiring: string,
  then: string,
) {
  if (input.serviceUnitPath === undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unit = yield* fs.readFileString(input.serviceUnitPath).pipe(Effect.option);
  if (Option.isNone(unit)) return undefined;
  const baseDir = bootServiceBaseDirOf(unit.value);
  if (baseDir === undefined || path.resolve(baseDir) !== path.resolve(retiring)) return undefined;
  return `The background service at ${input.serviceUnitPath} serves ${retiring}. Run \`t3 service uninstall\`, ${then}, then \`t3 service install\` so it serves the right storage.`;
});

const readRecord = <A, E>(recordPath: string, decode: (raw: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(recordPath).pipe(Effect.option);
    if (Option.isNone(raw)) return Option.none<A>();
    return Option.some(
      yield* decode(raw.value).pipe(
        Effect.mapError(
          (cause) => new StorageMigrationMarkerError({ markerPath: recordPath, cause }),
        ),
      ),
    );
  });

const writeRecord = (recordPath: string, contents: string) =>
  writeFileStringAtomically({ filePath: recordPath, contents: `${contents}\n` }).pipe(
    Effect.mapError((cause) => new StorageMigrationMarkerError({ markerPath: recordPath, cause })),
  );

/** A database's sidecars would be replayed into the copy placed beside them. */
const databaseSidecarsOf = (entry: Pick<StorageMigrationEntry, "kind" | "destination">) =>
  entry.kind === "database"
    ? DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${entry.destination}${suffix}`)
    : [];

type EntryKind =
  | { readonly kind: "symlink"; readonly linkTarget: string; readonly linkValue: string }
  | { readonly kind: "database" | "directory" | "file" };

const classify = Effect.fn("storageMigration.classify")(function* (source: string) {
  const fs = yield* FileSystem.FileSystem;
  const linkTarget = yield* absoluteLinkTarget(source);
  if (Option.isSome(linkTarget)) {
    const linkValue = yield* fs.readLink(source);
    return Option.some<EntryKind>({ kind: "symlink", linkTarget: linkTarget.value, linkValue });
  }
  const info = yield* fs.stat(source).pipe(Effect.option);
  if (Option.isNone(info)) return Option.none<EntryKind>();
  return Option.some<EntryKind>({
    kind: source.endsWith(".sqlite")
      ? "database"
      : info.value.type === "Directory"
        ? "directory"
        : "file",
  });
});

/** Decides what goes where without writing anything. */
export const planStorageMigration = Effect.fn("storageMigration.plan")(function* (
  input: StorageMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { legacyRoots, serverOverrides, serverRoots } = input;
  const legacyStateDir = legacyRoots.stateDir;
  const marker = yield* readRecord(
    legacyT3StorageMigrationMarkerPath(legacyRoots, path),
    decodeMarker,
  );
  const journal = yield* readRecord(
    legacyT3StorageMigrationJournalPath(legacyRoots, path),
    decodeJournal,
  );
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
  const routes = new Map(
    names.map((name) => [name, routeLegacyEntry(name, { hasV2Database }, input)] as const),
  );
  /**
   * A link into the tree being migrated follows its target to the migrated
   * copy; any other link keeps resolving to the same absolute path.
   */
  const relink = (kind: EntryKind, destination: string): EntryKind => {
    if (kind.kind !== "symlink") return kind;
    const inside = path.relative(legacyStateDir, kind.linkTarget);
    const [top, ...rest] = inside.split(path.sep);
    const route = top === undefined ? undefined : routes.get(top);
    if (
      inside === "" ||
      inside.startsWith("..") ||
      path.isAbsolute(inside) ||
      route === undefined ||
      "skipReason" in route
    ) {
      return { ...kind, linkValue: kind.linkTarget };
    }
    const linkTarget = path.join(route.root, top!, ...rest);
    return {
      kind: "symlink",
      linkTarget,
      linkValue: path.isAbsolute(kind.linkValue)
        ? linkTarget
        : path.relative(path.dirname(destination), linkTarget),
    };
  };
  for (const name of names.toSorted()) {
    const source = path.join(legacyStateDir, name);
    const route = routes.get(name)!;
    if ("skipReason" in route) {
      skipped.push({ path: source, reason: route.skipReason });
      continue;
    }
    const kind = yield* classify(source);
    if (Option.isNone(kind)) continue;
    const destination = path.join(route.root, name);
    sources.push({ owner: route.owner, source, destination, ...relink(kind.value, destination) });
  }

  const legacyProfile = yield* classify(input.legacyElectronProfile);
  if (Option.isSome(legacyProfile)) {
    sources.push({
      owner: "client",
      source: input.legacyElectronProfile,
      destination: input.electronProfile,
      ...relink(legacyProfile.value, input.electronProfile),
    });
  }
  for (const profile of [input.legacyElectronProfile, input.electronProfile]) {
    const desktop = yield* runningDesktopBlocker(profile);
    if (desktop !== undefined) blockers.push(desktop);
  }

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
          ? `threads reference these worktrees by path; new worktrees go to ${path.join(serverOverrides.dataDir ?? serverRoots.dataDir, "worktrees")}`
          : name === "caches"
            ? `regenerated under ${serverRoots.cacheDir}`
            : name === "bin"
              ? LAUNCHER_SKIP_REASON
              : "not part of the userdata tree; left in place",
    });
  }

  for (const runtimeStatePath of runtimeStatePaths(input, path)) {
    const server = yield* liveServerBlocker(runtimeStatePath);
    if (server !== undefined) blockers.push(server);
  }
  if (Option.isNone(marker)) {
    const service = yield* serviceBlocker(input, legacyRoots.legacyBaseDir, "migrate");
    if (service !== undefined) blockers.push(service);
  }

  const entries: Array<StorageMigrationEntry> = [];
  for (const entry of sources) {
    const exclude = excludedFor(input, entry.destination);
    const files =
      entry.kind === "directory"
        ? yield* walk(entry.source, exclude)
        : entry.kind === "symlink"
          ? []
          : [{ relativePath: "", size: Number((yield* fs.stat(entry.source)).size) }];
    const status: StorageMigrationEntry["status"] = !(yield* pathExists(entry.destination))
      ? (yield* Effect.forEach(databaseSidecarsOf(entry), pathExists)).some(Boolean)
        ? "conflict"
        : "copy"
      : entry.kind === "database"
        ? "conflict"
        : entry.kind === "symlink"
          ? Option.getOrUndefined(yield* absoluteLinkTarget(entry.destination)) === entry.linkTarget
            ? "present"
            : "conflict"
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
    interruptedAt: Option.getOrUndefined(Option.map(journal, (value) => value.startedAt)),
    entries,
    skipped,
    blockers,
  } satisfies StorageMigrationPlan;
});

/** Writes `entry` to `target`, a path that does not exist yet. */
const copyEntry = Effect.fn("storageMigration.copyEntry")(function* (
  entry: StorageMigrationEntry,
  target: string,
  exclude: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
  switch (entry.kind) {
    case "symlink":
      return yield* fs.symlink(entry.linkValue!, target);
    case "database":
      yield* snapshotDatabase(entry.source, target);
      return yield* fs.chmod(target, 0o600);
    case "file":
      yield* fs.copyFile(entry.source, target);
      return yield* fs.chmod(target, (yield* fs.stat(entry.source)).mode & 0o777);
    case "directory":
      return yield* copyTree(entry.source, target, exclude);
  }
});

/** Checks the copy at `copy` against the entry's source. */
const verifyEntry = Effect.fn("storageMigration.verifyEntry")(function* (
  entry: StorageMigrationEntry,
  copy: string,
  exclude: ReadonlySet<string>,
) {
  const fail = (check: string) =>
    new StorageMigrationVerificationError({ destination: entry.destination, check });
  switch (entry.kind) {
    case "symlink": {
      const target = yield* absoluteLinkTarget(copy);
      if (Option.getOrUndefined(target) !== entry.linkTarget) {
        return yield* fail("the link names a different target");
      }
      return;
    }
    case "database": {
      const integrity = yield* tryDatabase(copy, (database) =>
        String(database.prepare("PRAGMA integrity_check").get()?.integrity_check),
      ).pipe(Effect.mapError(() => fail("could not open the copy")));
      if (integrity !== "ok") return yield* fail(`integrity_check: ${integrity}`);
      const [source, copied] = yield* Effect.all([
        databaseFingerprint(entry.source),
        databaseFingerprint(copy),
      ]).pipe(Effect.mapError(() => fail("could not count rows")));
      if (source !== copied) return yield* fail("row counts differ from the source");
      return;
    }
    case "file":
      if (!(yield* sameFile(entry.source, copy))) {
        return yield* fail("contents differ from the source");
      }
      return;
    case "directory": {
      const difference = yield* firstDifference(entry.source, copy, exclude);
      if (difference !== undefined) return yield* fail(`${difference} differs from the source`);
    }
  }
});

/** Copies that a killed run left beside these destinations before it wrote a journal. */
const removeStaleStagedCopies = Effect.fn("storageMigration.removeStaleStagedCopies")(function* (
  destinations: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const destination of destinations) {
    const prefix = `${path.basename(destination)}.migrating-`;
    const names = yield* fs
      .readDirectory(path.dirname(destination))
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const name of names) {
      if (name.startsWith(prefix)) {
        yield* removeWithSidecars(path.join(path.dirname(destination), name));
      }
    }
  }
});

/**
 * Undoes a run that stopped while placing its copies. The journal is written
 * only once every staged copy exists, so a missing staged copy means it was
 * placed, and a missing `replaced` means its original was already restored.
 * While the journal exists selection never uses the split layout, so the
 * placed copies were never read and are removed.
 */
const undoJournal = Effect.fn("storageMigration.undoJournal")(function* (
  journalPath: string,
  journal: StorageMigrationJournal,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const entry of journal.entries.toReversed()) {
    const staged = yield* pathExists(entry.staged);
    if (entry.replaced !== undefined && !(yield* pathExists(entry.replaced))) {
      if (staged) yield* removeWithSidecars(entry.staged);
      continue;
    }
    if (staged) {
      yield* removeWithSidecars(entry.staged);
    } else {
      yield* removeWithSidecars(entry.destination);
    }
    if (entry.replaced !== undefined) {
      yield* moveWithSidecars(entry.replaced, entry.destination).pipe(
        Effect.mapError(
          (cause) =>
            new StorageMigrationMoveError({ from: entry.replaced!, to: entry.destination, cause }),
        ),
      );
    }
  }
  yield* fs.remove(journalPath, { force: true });
});

const undoInterruptedRun = Effect.fn("storageMigration.undoInterruptedRun")(function* (
  input: StorageMigrationInput,
) {
  const path = yield* Path.Path;
  const journalPath = legacyT3StorageMigrationJournalPath(input.legacyRoots, path);
  const journal = yield* readRecord(journalPath, decodeJournal);
  if (Option.isNone(journal)) return false;
  yield* undoJournal(journalPath, journal.value);
  return true;
});

/**
 * Holds `storage-migration.lock` in the legacy tree while `effect` runs, so a
 * second migration or rollback cannot undo the first one's journal. A lock
 * whose process is gone is taken over.
 */
const withMigrationLock = <A, E, R>(input: StorageMigrationInput, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = input.legacyRoots.stateDir;
    // Without userdata there is no journal to protect, and a mistyped --base-dir stays untouched.
    if (!(yield* fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* effect;
    }
    const lockPath = path.join(stateDir, MIGRATION_LOCK);
    const acquire = Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const created = yield* fs
          .writeFileString(lockPath, `${String(process.pid)}\n`, { flag: "wx" })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () => Effect.succeed(false),
            ),
          );
        if (created) return;
        const owner = Number(
          (yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => ""))).trim(),
        );
        if (Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) {
          return yield* new StorageMigrationBlockedError({
            blockers: [
              `Another \`t3 storage migrate\` is running (pid ${String(owner)}). Wait for it to finish; if no such process exists, remove ${lockPath}.`,
            ],
          });
        }
        yield* fs.remove(lockPath, { force: true });
      }
      return yield* new StorageMigrationBlockedError({
        blockers: [`Could not take the migration lock at ${lockPath}.`],
      });
    });
    return yield* Effect.acquireUseRelease(
      acquire,
      () => effect,
      () => fs.remove(lockPath, { force: true }).pipe(Effect.ignore),
    );
  });

/** Staging directories that a killed record write left in the legacy tree. */
const removeRecordLeftovers = Effect.fn("storageMigration.removeRecordLeftovers")(function* (
  input: StorageMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(input.legacyRoots.stateDir)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  for (const name of names.filter(isRecordLeftover)) {
    yield* fs.remove(path.join(input.legacyRoots.stateDir, name), { recursive: true, force: true });
  }
});

/**
 * Copies, verifies, then marks the legacy tree as migrated. A rerun after
 * success is a no-op; a failure, or a rerun after a killed run, removes what
 * the run wrote and restores anything it moved aside.
 */
export const runStorageMigration = Effect.fn("storageMigration.run")(function* (
  input: StorageMigrationInput,
  options: { readonly replaceExisting: boolean },
) {
  return yield* withMigrationLock(input, runLocked(input, options));
});

const runLocked = Effect.fn("storageMigration.runLocked")(function* (
  input: StorageMigrationInput,
  options: { readonly replaceExisting: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* removeRecordLeftovers(input);
  const markerPath = legacyT3StorageMigrationMarkerPath(input.legacyRoots, path);
  const journalPath = legacyT3StorageMigrationJournalPath(input.legacyRoots, path);
  const firstPlan = yield* planStorageMigration(input);
  if (firstPlan.migratedAt !== undefined) {
    // A run killed after its marker but before removing its journal had finished.
    yield* fs.remove(journalPath, { force: true });
    return { plan: firstPlan, migrated: false, replaced: [] } as const;
  }
  if (firstPlan.blockers.length > 0) {
    return yield* new StorageMigrationBlockedError({ blockers: firstPlan.blockers });
  }
  const plan = (yield* undoInterruptedRun(input)) ? yield* planStorageMigration(input) : firstPlan;
  const conflicts = plan.entries.filter((entry) => entry.status === "conflict");
  if (conflicts.length > 0 && !options.replaceExisting) {
    return yield* new StorageMigrationConflictError({
      destinations: conflicts.map((entry) => entry.destination),
    });
  }
  yield* removeStaleStagedCopies(plan.entries.map((entry) => entry.destination));

  const now = yield* DateTime.now;
  const suffix = uniqueSuffix(now);
  const toPlace = plan.entries
    .filter((entry) => entry.status !== "present")
    .map((entry) => ({
      entry,
      staged: `${entry.destination}.migrating-${suffix}`,
      ...(entry.status === "conflict"
        ? { replaced: `${entry.destination}.pre-migration-${suffix}` }
        : {}),
    }))
    .toSorted(
      (left, right) =>
        Number(SPLIT_INSTALL_MARKERS.has(path.basename(left.entry.destination))) -
        Number(SPLIT_INSTALL_MARKERS.has(path.basename(right.entry.destination))),
    );

  yield* Effect.forEach(
    toPlace,
    ({ entry, staged }) => {
      const exclude = excludedFor(input, entry.destination);
      return copyEntry(entry, staged, exclude).pipe(
        Effect.mapError(
          (cause) =>
            new StorageMigrationCopyError({
              source: entry.source,
              destination: entry.destination,
              cause,
            }),
        ),
        Effect.andThen(verifyEntry(entry, staged, exclude)),
      );
    },
    { discard: true },
  ).pipe(
    Effect.onError(() =>
      Effect.forEach(toPlace, ({ staged }) => removeWithSidecars(staged).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
  );

  const journal: StorageMigrationJournal = {
    version: 1,
    startedAt: DateTime.formatIso(now),
    entries: toPlace.map(({ entry, staged, replaced }) => ({
      destination: entry.destination,
      staged,
      ...(replaced === undefined ? {} : { replaced }),
    })),
  };
  yield* writeRecord(journalPath, yield* encodeJournal(journal));
  yield* Effect.gen(function* () {
    for (const { entry, staged, replaced } of toPlace) {
      const place = Effect.gen(function* () {
        if (replaced !== undefined) yield* moveWithSidecars(entry.destination, replaced);
        yield* moveWithSidecars(staged, entry.destination);
      });
      yield* place.pipe(
        Effect.mapError(
          (cause) => new StorageMigrationMoveError({ from: staged, to: entry.destination, cause }),
        ),
      );
    }
    const placed = new Map(toPlace.map((item) => [item.entry.destination, item]));
    const markerEntries: Array<MarkerEntry> = plan.entries.map((entry) => {
      const replaced = placed.get(entry.destination)?.replaced;
      return {
        source: entry.source,
        destination: entry.destination,
        ...(replaced === undefined ? {} : { replaced }),
        ...(entry.status === "present" ? { preexisting: true } : {}),
      };
    });
    yield* writeRecord(
      markerPath,
      yield* encodeMarker({
        version: 1,
        migratedAt: DateTime.formatIso(now),
        entries: markerEntries,
      }),
    );
  }).pipe(Effect.onError(() => undoJournal(journalPath, journal).pipe(Effect.ignore)));
  yield* fs.remove(journalPath, { force: true }).pipe(Effect.ignore);

  return {
    plan,
    migrated: true,
    replaced: toPlace.flatMap(({ replaced }) => (replaced === undefined ? [] : [replaced])),
  } as const;
});

/**
 * Returns to the legacy tree: each copy the migration placed is renamed aside
 * (never deleted, so anything written since survives), anything it replaced is
 * restored, and the marker is removed. Entries already restored are skipped, so
 * a rollback that stopped partway can be rerun. After a killed migration it
 * undoes that run instead.
 */
export const rollbackStorageMigration = Effect.fn("storageMigration.rollback")(function* (
  input: StorageMigrationInput,
) {
  return yield* withMigrationLock(input, rollbackLocked(input));
});

const rollbackLocked = Effect.fn("storageMigration.rollbackLocked")(function* (
  input: StorageMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* removeRecordLeftovers(input);
  const markerPath = legacyT3StorageMigrationMarkerPath(input.legacyRoots, path);
  const marker = yield* readRecord(markerPath, decodeMarker);
  const blockers: Array<string> = [];
  for (const runtimeStatePath of runtimeStatePaths(input, path)) {
    const server = yield* liveServerBlocker(runtimeStatePath);
    if (server !== undefined) blockers.push(server);
  }
  const desktop = yield* runningDesktopBlocker(input.electronProfile);
  if (desktop !== undefined) blockers.push(desktop);
  const service = yield* serviceBlocker(input, input.serverRoots.dataDir, "roll back");
  if (service !== undefined) blockers.push(service);
  if (blockers.length > 0) return yield* new StorageMigrationBlockedError({ blockers });
  if (Option.isNone(marker)) {
    return {
      outcome: (yield* undoInterruptedRun(input)) ? "undid-interrupted-run" : "not-migrated",
      rolledBack: [] as ReadonlyArray<string>,
    } as const;
  }

  yield* fs.remove(legacyT3StorageMigrationJournalPath(input.legacyRoots, path), { force: true });
  const suffix = uniqueSuffix(yield* DateTime.now);
  const rolledBack: Array<string> = [];
  for (const entry of marker.value.entries) {
    if (entry.preexisting === true) continue;
    if (entry.replaced !== undefined && !(yield* pathExists(entry.replaced))) continue;
    const aside = `${entry.destination}.rolled-back-${suffix}`;
    yield* Effect.gen(function* () {
      if (yield* moveWithSidecars(entry.destination, aside)) rolledBack.push(aside);
      if (entry.replaced !== undefined) yield* moveWithSidecars(entry.replaced, entry.destination);
    }).pipe(
      Effect.mapError(
        (cause) => new StorageMigrationMoveError({ from: entry.destination, to: aside, cause }),
      ),
    );
  }
  yield* fs.remove(markerPath);
  return { outcome: "rolled-back", rolledBack } as const;
});
