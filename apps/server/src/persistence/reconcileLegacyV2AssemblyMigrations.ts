import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ApplicationEventSequenceIndexes from "./Migrations/OrchestrationV2/ApplicationEventSequenceIndexes.ts";
import ApplicationEventSource from "./Migrations/OrchestrationV2/ApplicationEventSource.ts";
import EffectCancellation from "./Migrations/OrchestrationV2/EffectCancellation.ts";
import Foundation from "./Migrations/OrchestrationV2/Foundation.ts";
import LegacyV1ImportState from "./Migrations/OrchestrationV2/LegacyV1ImportState.ts";
import ProviderSessionBindings from "./Migrations/OrchestrationV2/ProviderSessionBindings.ts";
import RecoveryIndexes from "./Migrations/OrchestrationV2/RecoveryIndexes.ts";
import ScheduledTasks from "./Migrations/OrchestrationV2/ScheduledTasks.ts";
import ShellIndexes from "./Migrations/OrchestrationV2/ShellIndexes.ts";
import Subagents from "./Migrations/OrchestrationV2/Subagents.ts";
import ThreadLaunchWorkflows from "./Migrations/OrchestrationV2/ThreadLaunchWorkflows.ts";

const ORCHESTRATION_V2 = "OrchestrationV2";

// The steps migration 55 composes, under the names pre-merge builds recorded
// them with. The base step is the marker and is never replayed.
const V2_STEPS = [
  ["OrchestrationV2Subagents", Subagents],
  ["OrchestrationV2Foundation", Foundation],
  ["OrchestrationV2ProviderSessionBindings", ProviderSessionBindings],
  ["OrchestrationV2ThreadLaunchWorkflows", ThreadLaunchWorkflows],
  ["ApplicationEventSource", ApplicationEventSource],
  ["OrchestrationV2EffectCancellation", EffectCancellation],
  ["ScheduledTasks", ScheduledTasks],
  ["LegacyV1ImportState", LegacyV1ImportState],
  ["ApplicationEventSequenceIndexes", ApplicationEventSequenceIndexes],
  ["OrchestrationV2RecoveryIndexes", RecoveryIndexes],
  ["OrchestrationV2ShellIndexes", ShellIndexes],
] as const;

// Fork-only repair that re-ran guarded column migrations (34-36, and later 48-49).
// It proves nothing by itself, so the guarded migrations it covered replay by name.
const ASSEMBLY_ONLY_NAMES = new Set(["ProjectionThreadSchemaCompatibility"]);

/**
 * Pre-merge V2 assembly builds recorded V2 as twelve migrations at ids 39 or
 * 48 onward, interleaved with main's later migrations under shifted ids. Re-key
 * that ledger onto this build's ids by name, running only what never ran.
 */
export const reconcileLegacyV2AssemblyMigrations = Effect.fn("reconcileLegacyV2AssemblyMigrations")(
  function* <E>(
    entries: ReadonlyArray<
      readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>]
    >,
    toMigrationInclusive: number | undefined,
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];
        const ledger = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
        const canonical = entries.find(([, name]) => name === ORCHESTRATION_V2);
        const legacyBase = ledger.find((row) => row.name === ORCHESTRATION_V2);
        if (!canonical || !legacyBase || legacyBase.migration_id >= 53) return [];

        const namesById = new Map<number, string>(entries.map(([id, name]) => [id, name]));
        const firstDivergent = ledger.find((row) => namesById.get(row.migration_id) !== row.name)!;
        const tail = ledger.filter((row) => row.migration_id >= firstDivergent.migration_id);
        const knownNames = new Set<string>([
          ...entries.map(([, name]) => name),
          ...V2_STEPS.map(([name]) => name),
          ...ASSEMBLY_ONLY_NAMES,
        ]);
        const unknown = tail.filter((row) => !knownNames.has(row.name));
        if (unknown.length > 0) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot re-key pre-merge V2 migrations with unknown entries: ${unknown
              .map((row) => `${row.migration_id}:${row.name}`)
              .join(", ")}.`,
          });
        }
        if (toMigrationInclusive !== undefined && toMigrationInclusive < canonical[0]) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Pre-merge V2 migrations can only be re-keyed by an upgrade that includes V2.",
          });
        }

        const recorded = new Map(tail.map((row) => [row.name, row.created_at]));
        const pending = entries.filter(
          ([id]) =>
            id >= firstDivergent.migration_id &&
            (toMigrationInclusive === undefined || id <= toMigrationInclusive),
        );
        const missingV2Steps = V2_STEPS.filter(([name]) => !recorded.has(name));
        const steps = pending.map(([id, name, migration]) => {
          if (name === ORCHESTRATION_V2) {
            const runs = missingV2Steps.length > 0;
            return [id, name, runs, Effect.forEach(missingV2Steps, ([, step]) => step)] as const;
          }
          const runs = !recorded.has(name);
          return [id, name, runs, runs ? migration : Effect.void] as const;
        });

        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${firstDivergent.migration_id}`;
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              steps.map(([id, name, , migration]) => [`${id}_${name}`, migration]),
            ),
          ),
        });
        for (const [id, name] of pending) {
          const createdAt = recorded.get(name);
          if (createdAt === undefined) continue;
          yield* sql`UPDATE effect_sql_migrations SET created_at = ${createdAt} WHERE migration_id = ${id}`;
        }
        return steps.flatMap(([id, name, runs]) => (runs ? [[id, name] as const] : []));
      }),
    );
  },
);
