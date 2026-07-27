// @effect-diagnostics globalDate:off - parses a fixed ISO string from the
// build record for display; it never reads the clock, so it is deterministic.
/**
 * Pure helpers for describing where a build came from.
 *
 * Kept separate from `buildProvenance.ts` so they stay testable: that module
 * reads values that only exist after vite's build-time `define` substitution.
 */

/**
 * Matches the remote forms git hands back for a GitHub repository:
 * `https://github.com/owner/repo(.git)`, the `x-access-token@` variant CI
 * checkouts leave behind, and `git@github.com:owner/repo(.git)`.
 */
const GITHUB_REMOTE_PATTERN =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/(.+?)(?:\.git)?\/?$/;

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

const SHORT_COMMIT_LENGTH = 12;

export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
}

export function parseGitHubRemote(remote: string): GitHubRepo | null {
  const match = GITHUB_REMOTE_PATTERN.exec(remote.trim());
  if (!match) return null;

  const [, owner, repo] = match;
  if (!owner || !repo) return null;

  return { owner, repo };
}

export function gitHubRepoUrl(remote: string): string | null {
  const parsed = parseGitHubRemote(remote);
  return parsed && `https://github.com/${parsed.owner}/${parsed.repo}`;
}

export function gitHubCommitUrl(remote: string, commit: string): string | null {
  const repoUrl = gitHubRepoUrl(remote);
  if (!repoUrl || !COMMIT_PATTERN.test(commit.trim())) return null;

  return `${repoUrl}/commit/${commit.trim()}`;
}

/**
 * Twelve characters, which is unambiguous well past this repository's size
 * while still fitting the settings version line.
 */
export function shortCommit(commit: string): string {
  return commit.trim().slice(0, SHORT_COMMIT_LENGTH);
}

const COMMIT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A commit date is a fixed point in the past, so it is rendered absolutely
 * rather than as "3 days ago" -- the question it answers is "which build is
 * this", and a relative answer changes every time you look at it.
 */
export function formatCommitDate(isoDate: string): string | null {
  const trimmed = isoDate.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : COMMIT_DATE_FORMAT.format(parsed);
}

export function formatRepoLabel(remote: string): string | null {
  const parsed = parseGitHubRemote(remote);
  return parsed && `${parsed.owner}/${parsed.repo}`;
}
