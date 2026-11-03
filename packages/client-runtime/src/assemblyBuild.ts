import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AssemblyBuildEntry = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  commit: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  remote: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(Schema.Number),
  summary: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  fixup: Schema.optionalKey(Schema.String),
});
export type AssemblyBuildEntry = typeof AssemblyBuildEntry.Type;

const AssemblyBuild = Schema.Struct({
  commit: Schema.NullOr(Schema.String),
  fork: Schema.optionalKey(
    Schema.Struct({
      remote: Schema.NullOr(Schema.String),
      branch: Schema.String,
    }),
  ),
  upstream: Schema.Struct({
    remote: Schema.String,
    ref: Schema.String,
    commit: Schema.String,
    subject: Schema.optionalKey(Schema.String),
    date: Schema.optionalKey(Schema.String),
    tag: Schema.optionalKey(Schema.String),
    distance: Schema.optionalKey(Schema.Number),
  }),
  entries: Schema.Array(AssemblyBuildEntry),
});
export type AssemblyBuild = typeof AssemblyBuild.Type;

const decodeAssemblyBuild = Schema.decodeUnknownOption(Schema.fromJsonString(AssemblyBuild));

export function parseAssemblyBuild(raw: string): AssemblyBuild | null {
  return raw.trim() === "" ? null : Option.getOrNull(decodeAssemblyBuild(raw));
}

/** The repository's web URL, or null when it is not hosted on GitHub. */
function githubRepositoryUrl(remote: string | null | undefined): string | null {
  const match = remote
    ?.trim()
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}` : null;
}

export function githubCommitUrl(remote: string | null | undefined, commit: string): string | null {
  const repository = githubRepositoryUrl(remote);
  return repository && commit ? `${repository}/commit/${commit}` : null;
}

export function githubBranchUrl(remote: string | null | undefined, branch: string): string | null {
  const repository = githubRepositoryUrl(remote);
  return repository
    ? `${repository}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`
    : null;
}

export function githubPullRequestUrl(remote: string | null | undefined, pr: number): string | null {
  const repository = githubRepositoryUrl(remote);
  return repository ? `${repository}/pull/${pr}` : null;
}

export function githubCompareUrl(
  remote: string | null | undefined,
  base: string,
  head: string,
): string | null {
  const repository = githubRepositoryUrl(remote);
  return repository ? `${repository}/compare/${base}...${head}` : null;
}

/** Carried entries name branches without a remote; every one is pushed to the fork. */
export function assemblyEntryRemote(
  build: AssemblyBuild,
  entry: AssemblyBuildEntry,
): string | null {
  return entry.remote ?? build.fork?.remote ?? null;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 10);
}
