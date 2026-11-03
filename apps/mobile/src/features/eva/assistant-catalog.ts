import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

// The native store refuses catalogs over 512 KiB; these bounds keep well under it.
const MAX_PROJECTS = 300;
const MAX_THREADS = 400;

export interface AssistantCatalogEnvironment {
  readonly id: string;
  readonly name: string;
  /** Connection phase, e.g. connected, connecting, offline, blocked. */
  readonly status: string;
}

export interface AssistantEnvironmentRow {
  readonly id: string;
  readonly name: string;
  readonly connected: number;
  readonly status: string;
}

export interface AssistantProjectRow {
  readonly id: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly repository: string;
}

export interface AssistantThreadRow {
  readonly id: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly lastActivityAt: string;
}

export interface AssistantCatalog {
  readonly version: 1;
  readonly capturedAt: string;
  readonly environments: ReadonlyArray<AssistantEnvironmentRow>;
  readonly projects: ReadonlyArray<AssistantProjectRow>;
  readonly threads: ReadonlyArray<AssistantThreadRow>;
}

type CatalogProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "repositoryIdentity" | "updatedAt"
>;

type CatalogThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "modelSelection"
  | "runtime"
  | "latestRun"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestUserMessageAt"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;

export function repositoryLabel(project: Pick<CatalogProject, "repositoryIdentity">): string {
  const identity = project.repositoryIdentity;
  if (!identity) return "";
  if (identity.owner && identity.name) return `${identity.owner}/${identity.name}`;
  return identity.displayName ?? identity.canonicalKey;
}

export function threadStatus(thread: CatalogThread): string {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs_input";
  return thread.runtime?.status ?? thread.latestRun?.status ?? "idle";
}

export function threadLastActivityAt(
  thread: Pick<CatalogThread, "updatedAt" | "latestUserMessageAt">,
): string {
  const latest = thread.latestUserMessageAt;
  return latest !== null && latest > thread.updatedAt ? latest : thread.updatedAt;
}

export function assistantThreadRow(input: {
  readonly thread: CatalogThread;
  readonly environmentName: string;
  readonly projectName: string;
}): AssistantThreadRow {
  const { thread } = input;
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    environmentName: input.environmentName,
    projectId: thread.projectId,
    projectName: input.projectName,
    title: thread.title,
    branch: thread.branch ?? "",
    worktreePath: thread.worktreePath ?? "",
    provider: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    status: threadStatus(thread),
    lastActivityAt: threadLastActivityAt(thread),
  };
}

/**
 * The bounded environment/project/thread catalog the assistant content
 * provider serves. Most recently active first; archived and deleted threads
 * are left out.
 */
export function buildAssistantCatalog(input: {
  readonly now: Date;
  readonly environments: ReadonlyArray<AssistantCatalogEnvironment>;
  readonly projects: ReadonlyArray<CatalogProject>;
  readonly threads: ReadonlyArray<CatalogThread>;
}): AssistantCatalog {
  const environmentNames = new Map(input.environments.map((env) => [env.id, env.name]));
  const projectKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const projectNames = new Map(
    input.projects.map((project) => [projectKey(project.environmentId, project.id), project.title]),
  );
  const threads = input.threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .map((thread) =>
      assistantThreadRow({
        thread,
        environmentName: environmentNames.get(thread.environmentId) ?? "",
        projectName: projectNames.get(projectKey(thread.environmentId, thread.projectId)) ?? "",
      }),
    )
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
    .slice(0, MAX_THREADS);
  const projectActivity = new Map<string, string>();
  for (const thread of threads) {
    const key = projectKey(thread.environmentId, thread.projectId);
    if (!projectActivity.has(key)) projectActivity.set(key, thread.lastActivityAt);
  }
  const projects = [...input.projects]
    .map((project) => ({
      row: {
        id: project.id,
        environmentId: project.environmentId,
        environmentName: environmentNames.get(project.environmentId) ?? "",
        name: project.title,
        workspaceRoot: project.workspaceRoot,
        repository: repositoryLabel(project),
      },
      activity:
        projectActivity.get(projectKey(project.environmentId, project.id)) ?? project.updatedAt,
    }))
    .sort((left, right) => right.activity.localeCompare(left.activity))
    .slice(0, MAX_PROJECTS)
    .map(({ row }) => row);
  return {
    version: 1,
    capturedAt: input.now.toISOString(),
    environments: input.environments.map((env) => ({
      id: env.id,
      name: env.name,
      connected: env.status === "connected" ? 1 : 0,
      status: env.status,
    })),
    projects,
    threads,
  };
}
