# t3-eva-extension

Android-only integration with [EVA](https://github.com/colonelpanic8/eva), an
on-device assistant. Only the signed EVA release app (or, in a debuggable
build, a debug EVA sharing this build's signer) may use it.

## Content provider

Authority `${applicationId}.assistant`, read-only, filtered by query parameters
only (selections and sort orders are refused, as are parameters a table does
not take).

| Table            | Parameters                                           | Columns                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/environments`  | `q`, `limit`                                         | `id`, `name`, `connected`, `status`                                                                                                                                                                                                                                                                                                                                   |
| `/projects`      | `environmentId`, `q`, `limit`                        | `id`, `environmentId`, `environmentName`, `name`, `workspaceRoot`, `repository`                                                                                                                                                                                                                                                                                       |
| `/threads`       | `environmentId`, `projectId`, `q`, `limit`           | `id`, `environmentId`, `environmentName`, `projectId`, `projectName`, `title`, `branch`, `worktreePath`, `provider`, `model`, `status`, `lastActivityAt`                                                                                                                                                                                                              |
| `/messages`      | `threadId` (required), `environmentId`, `limit` ≤ 50 | `id`, `environmentId`, `environmentName`, `threadId`, `threadTitle`, `role`, `createdAt`, `text`                                                                                                                                                                                                                                                                      |
| `/models`        | `environmentId` (required), `provider`, `q`, `limit` | `environmentId`, `environmentName`, `provider`, `providerLabel`, `status`, `model`, `modelLabel`, `isDefault`, `options`, `note`                                                                                                                                                                                                                                      |
| `/requests`      | `environmentId`, `threadId`, `limit`                 | `requestId`, `environmentId`, `environmentName`, `threadId`, `threadTitle`, `kind`, `requestKind`, `createdAt`, `detail`, `decisions`, `questions`, `answerable`, `dismissible`                                                                                                                                                                                       |
| `/thread_status` | `threadId` (required), `environmentId`               | `id`, `environmentId`, `environmentName`, `projectId`, `projectName`, `title`, `status`, `activeRunStatus`, `queuedCount`, `pendingApprovals`, `pendingQuestions`, `branch`, `worktreePath`, `provider`, `model`, `modelOptions`, `runtimeMode`, `interactionMode`, `pinned`, `archived`, `settled`, `snoozedUntil`, `lastActivityAt`, `lastAssistantMessage`, `note` |
| `/queue`         | `threadId` (required), `environmentId`, `limit`      | `runId`, `environmentId`, `environmentName`, `threadId`, `threadTitle`, `position`, `text`, `held`, `canSteer`                                                                                                                                                                                                                                                        |

The first three tables come from a catalog the app publishes while it runs, plus
threads EVA started or forked since; a headless run that reaches every
environment republishes it too. The other tables are answered live by a
headless JavaScript task, which starts React Native when the app is not running;
a failure is a single `notice` row rather than an error. `/requests` without an
`environmentId` covers every enabled environment and adds a `notice` row for
each one it could not reach.

## Extension service

EVA's installed-extension protocol v1 (AIDL) exposes the tables above directly as
`list_environments`, `list_projects`, `list_threads`, `read_messages`, `list_models`,
`list_requests`, `get_thread_status`, and `list_queued_messages`. These reads do
not require permission to run threads. Results include rows as both text and
structured data; oversized replies set `truncated`. Narrow the query when that
happens. Environment, project, and thread listings use the app's cached catalog;
open T3 Code to refresh missing entries.

For parallel independent tasks, call `start_thread` once per task with a
self-contained prompt and `workspace=worktree` for concurrent edits. Keep each
invocation ID and environment/thread pair. `request_status` tracks whether the
action reached T3 Code; `get_thread_status` and `read_messages` track the work.
For coordinated child agents and result collection, start one coordinator
thread and ask it to delegate. Separate extension invocations create independent
conversations.

Write tools include `start_thread`,
`send_message`, `interrupt_thread`, `organize_thread`, `respond_to_approval`,
`answer_question`, `dismiss_question`, `rename_thread`, `configure_thread`,
`fork_thread`, `manage_queued_message`, and `request_status`. Each request is journaled under the
caller's UID and invocation ID before anything is sent, and its commands carry
IDs derived from that key, so a replay after a lost reply or process death gets
the server's recorded outcome instead of running twice. Requests are refused
before the first unlock and when **Settings > Thread behavior > Let EVA run
threads** is off.

Environments that connect through T3 Connect need a sign-in only the app's UI
can provide; until then requests to them report `needs_configuration`.
