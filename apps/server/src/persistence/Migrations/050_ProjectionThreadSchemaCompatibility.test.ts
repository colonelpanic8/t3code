import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionThreadSchemaCompatibility", (it) => {
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
      yield* runMigrations({ toMigrationInclusive: 50 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));

      assert.ok(names.has("snoozed_until"));
      assert.ok(names.has("snoozed_at"));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));
      assert.ok(names.has("pinned_at"));

      const migration = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM effect_sql_migrations
        WHERE migration_id = 50
      `;
      assert.equal(migration[0]?.name, "ProjectionThreadSchemaCompatibility");
    }),
  );
});
