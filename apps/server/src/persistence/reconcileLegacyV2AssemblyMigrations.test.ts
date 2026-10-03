import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

const V2_NAMES = [
  "OrchestrationV2",
  "OrchestrationV2Subagents",
  "OrchestrationV2Foundation",
  "OrchestrationV2ProviderSessionBindings",
  "OrchestrationV2ThreadLaunchWorkflows",
  "ApplicationEventSource",
  "OrchestrationV2EffectCancellation",
  "ScheduledTasks",
  "LegacyV1ImportState",
  "ApplicationEventSequenceIndexes",
  "OrchestrationV2RecoveryIndexes",
  "OrchestrationV2ShellIndexes",
] as const;
const COMPATIBILITY = "ProjectionThreadSchemaCompatibility";
const RECORDED_AT = "2026-08-10 18:03:28";

const migrationNamed = (name: string) => migrationEntries.find(([, entry]) => entry === name)![2];

/** Applies and records `names` from `startId`, the way pre-merge assemblies did. */
const seedAssembly = (startId: number, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: startId - 1 });
    for (const [index, name] of names.entries()) {
      if (name === "OrchestrationV2") {
        yield* OrchestrationV2;
      } else if (name === COMPATIBILITY) {
        for (const id of [34, 35, 36]) yield* migrationEntries.find(([entry]) => entry === id)![2];
      } else if (!V2_NAMES.includes(name as (typeof V2_NAMES)[number])) {
        yield* migrationNamed(name);
      }
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (${startId + index}, ${name}, ${RECORDED_AT})
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, imported_message_count)
      VALUES ('thread:preserved', '2026-08-10', '2026-08-10', 27)
    `;
  });

// Ledger shape of the final pre-merge assembly, after its own renumbering repair.
const repairedAssemblyNames = [
  ...V2_NAMES,
  COMPATIBILITY,
  "ProjectionThreadsActiveOrderKey",
  COMPATIBILITY,
] as const;

// Earlier assemblies put V2 at 39 and shifted main's next migrations after it.
const earlyAssemblyNames = [
  ...V2_NAMES,
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
  COMPATIBILITY,
  "ProjectionThreadLinkedPullRequest",
  "ProjectionThreadsUnsettledAt",
] as const;

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const assertCanonicalUpgrade = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* readLedger, migrationManifest);
  assert.deepStrictEqual(
    yield* sql`SELECT thread_id, imported_message_count FROM orchestration_v2_legacy_imports`,
    [{ thread_id: "thread:preserved", imported_message_count: 27 }],
  );
  assert.deepStrictEqual(
    yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
    [{ created_at: RECORDED_AT }],
  );
  const threadColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  for (const column of [
    "title_state_json",
    "auto_settle_disabled_at",
    "branch_pull_request_json",
  ]) {
    assert.ok(
      threadColumns.some(({ name }) => name === column),
      column,
    );
  }
  assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 0);
  assert.deepStrictEqual(yield* runMigrations(), []);
});

describe("pre-merge V2 assembly upgrade", () => {
  it.effect("re-keys the repaired assembly ledger and runs only main's missing migrations", () =>
    Effect.gen(function* () {
      yield* seedAssembly(48, repairedAssemblyNames);
      assert.deepStrictEqual(yield* runMigrations(), [
        [48, "ProjectionThreadBranchPullRequest"],
        [50, "ProjectionThreadPullRequests"],
        [51, "ProjectionThreadMessageContext"],
        [52, "ProjectionThreadTitleState"],
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      yield* assertCanonicalUpgrade;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("re-keys the early assembly ledger that numbered V2 from 39", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedAssembly(39, earlyAssemblyNames);
      const executed = yield* runMigrations();
      assert.ok(executed.some(([id]) => id === 41));
      assert.ok(!executed.some(([id]) => id === 39 || id === 42 || id === 55));
      const authColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.ok(authColumns.some(({ name }) => name === "client_surface"));
      yield* assertCanonicalUpgrade;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("finishes V2 setup steps an older assembly never recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedAssembly(
        48,
        repairedAssemblyNames.filter((name) => name !== "OrchestrationV2ShellIndexes"),
      );
      yield* sql`DROP INDEX orchestration_v2_projection_turn_items_thread_run_idx`;
      yield* sql`DROP INDEX orchestration_v2_projection_turn_items_shell_pending_idx`;
      yield* sql`DROP INDEX orchestration_v2_projection_messages_latest_user_idx`;
      assert.ok((yield* runMigrations()).some(([id]) => id === 55));
      const indexes = yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'orchestration_v2_projection_messages_latest_user_idx'
      `;
      assert.strictEqual(indexes.length, 1);
      yield* assertCanonicalUpgrade;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back the ledger and schema when a replayed migration fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedAssembly(48, repairedAssemblyNames);
      // Migration 52 adds this column unguarded, so the replay fails after 50 and 51 ran.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_pull_requests'
      `;
      assert.strictEqual(tables.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to re-key a ledger with migrations this build does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedAssembly(48, repairedAssemblyNames);
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'ForkOnlyMigration')
      `;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
