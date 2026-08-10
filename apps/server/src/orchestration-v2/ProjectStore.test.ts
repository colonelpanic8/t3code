import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("lists worktree paths of live threads in active projects", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const createProject = (projectId: ProjectId, sequence: number) =>
          projects.apply({
            sequence,
            eventId: EventId.make(`event-${projectId}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: "2026-03-24T00:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: projectId,
              workspaceRoot: `/tmp/${projectId}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-03-24T00:00:00.000Z",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          });
        const activeProjectId = ProjectId.make("project-worktrees-active");
        const deletedProjectId = ProjectId.make("project-worktrees-deleted");
        yield* createProject(activeProjectId, 10);
        yield* createProject(deletedProjectId, 11);
        yield* projects.apply({
          sequence: 12,
          eventId: EventId.make("event-project-worktrees-deleted-removed"),
          aggregateKind: "project",
          aggregateId: deletedProjectId,
          occurredAt: "2026-03-25T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProjectId, deletedAt: "2026-03-25T00:00:00.000Z" },
        });
        const insertThread = (
          threadId: string,
          projectId: ProjectId,
          worktreePath: string | null,
          deletedAt: string | null = null,
        ) => sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          )
          VALUES (
            ${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default',
            '2026-03-24T00:00:00.000Z', '2026-03-24T00:00:00.000Z', ${deletedAt},
            ${JSON.stringify({ worktreePath })}
          )
        `;
        yield* insertThread("thread-live", activeProjectId, "/worktrees/live");
        yield* insertThread("thread-live-same", activeProjectId, "/worktrees/live");
        yield* insertThread("thread-local", activeProjectId, null);
        yield* insertThread("thread-deleted", activeProjectId, "/worktrees/deleted", "2026-03-25");
        yield* insertThread("thread-orphaned", deletedProjectId, "/worktrees/orphaned");

        assert.deepStrictEqual(yield* projects.listActiveThreadWorktreePaths(), [
          "/worktrees/live",
        ]);
      }),
    );
  },
);
