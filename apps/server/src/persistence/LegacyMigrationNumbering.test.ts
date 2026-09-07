import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const legacyCompatibilityName = "ProjectionThreadSchemaCompatibility" as const;
const legacyCompatibilityMigration = Effect.gen(function* () {
  for (const migrationId of [34, 35, 36] as const) {
    const [, , migration] = migrationEntries.find(([id]) => id === migrationId)!;
    yield* migration;
  }
});

const seedLegacyDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 38 });
  // Released private assemblies, including repeated schema repair migrations.
  const legacyOrder = [
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    39,
    40,
    legacyCompatibilityName,
    42,
    43,
    legacyCompatibilityName,
    legacyCompatibilityName,
  ] as const;
  for (const [index, canonicalId] of legacyOrder.entries()) {
    const [, name, migration] =
      canonicalId === legacyCompatibilityName
        ? ([60, legacyCompatibilityName, legacyCompatibilityMigration] as const)
        : migrationEntries.find(([id]) => id === canonicalId)!;
    yield* migration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (${39 + index}, ${name}, '2026-08-10 18:03:28')
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, imported_message_count)
    VALUES ('thread:preserved', '2026-08-10', '2026-08-10', 27)
  `;
});

it.effect("upgrades legacy v2 numbering without replaying applied migrations or losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyDatabase;
    const executed = yield* runMigrations();
    assert.ok(executed.some(([id]) => id === 41));
    assert.ok(executed.some(([id]) => id === 47));
    assert.ok(!executed.some(([, name]) => name === "LegacyV1ImportState"));
    const ledger = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepStrictEqual(
      ledger.map(({ migration_id, name }) => [migration_id, name]),
      migrationManifest.map(([id, name]) => [id, name]),
    );
    const imports =
      yield* sql`SELECT thread_id, imported_message_count FROM orchestration_v2_legacy_imports`;
    assert.deepStrictEqual(imports, [
      { thread_id: "thread:preserved", imported_message_count: 27 },
    ]);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(auth_sessions)`;
    assert.ok(columns.some(({ name }) => name === "client_surface"));
    const dates = yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 56`;
    assert.deepStrictEqual(dates, [{ created_at: "2026-08-10 18:03:28" }]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back both ledger repair and schema changes when an upgrade fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyDatabase;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* sql`CREATE INDEX idx_orchestration_events_application_high_water ON orchestration_events(sequence)`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(auth_sessions)`;
    assert.ok(!columns.some(({ name }) => name === "client_surface"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses a partial upgrade that would discard already applied migration records", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyDatabase;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }))));
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
