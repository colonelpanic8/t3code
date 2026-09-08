import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_ProjectionThreadSchemaCompatibility", (it) => {
  it.effect("repairs schemas whose older migrations reused IDs 34 through 36", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (34, 'ProjectionThreadGoals'),
          (35, 'ProjectionThreadForkLineage'),
          (36, 'ProjectionThreadsSnoozed')
      `;
      yield* runMigrations({ toMigrationInclusive: 62 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));

      assert.ok(names.has("snoozed_until"));
      assert.ok(names.has("snoozed_at"));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));
      assert.ok(names.has("pinned_at"));
      assert.ok(names.has("branch_pull_request_json"));
      assert.ok(names.has("active_order_key"));

      const migration = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM effect_sql_migrations
        WHERE migration_id = 62
      `;
      assert.equal(migration[0]?.name, "ProjectionThreadSchemaCompatibility");
    }),
  );

  it.effect("repairs new columns after the old compatibility migration occupied slot 60", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (60, 'ProjectionThreadSchemaCompatibility')
      `;

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const beforeNames = new Set(before.map((column) => column.name));
      assert.ok(!beforeNames.has("branch_pull_request_json"));
      assert.ok(!beforeNames.has("active_order_key"));

      const executed = yield* runMigrations({ toMigrationInclusive: 62 });
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [61, 62],
      );

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const afterNames = new Set(after.map((column) => column.name));
      assert.ok(afterNames.has("branch_pull_request_json"));
      assert.ok(afterNames.has("active_order_key"));
    }),
  );
});
