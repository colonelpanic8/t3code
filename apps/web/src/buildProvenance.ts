import {
  formatRepoLabel,
  gitHubCommitUrl,
  gitHubRepoUrl,
  shortCommit,
} from "./buildProvenance.logic";

/**
 * Which commit of which repository this bundle was built from.
 *
 * `APP_VERSION` answers "which release line is this"; it cannot answer "is this
 * the build with the fix I just merged", because every build off a given
 * package version shares it. These values are injected at build time from git
 * (see apps/web/vite.config.ts) or, where there is no git context to read --
 * a Nix sandbox, an unpacked source tarball -- from `T3CODE_BUILD_*` env vars
 * supplied by whatever performs the build.
 *
 * Every value is optional. A build with no provenance is normal, so consumers
 * must render its absence rather than a placeholder commit.
 */

export const BUILD_COMMIT = import.meta.env.BUILD_COMMIT?.trim() ?? "";
export const BUILD_REPO_REMOTE = import.meta.env.BUILD_REPO_REMOTE?.trim() ?? "";

/** ISO 8601 committer date of `BUILD_COMMIT`, not the moment of the build. */
export const BUILD_DATE = import.meta.env.BUILD_DATE?.trim() ?? "";

/** Tracked files differed from `BUILD_COMMIT` when the bundle was built. */
export const BUILD_DIRTY = import.meta.env.BUILD_DIRTY === true;

export const BUILD_COMMIT_SHORT = shortCommit(BUILD_COMMIT);
export const BUILD_COMMIT_URL = gitHubCommitUrl(BUILD_REPO_REMOTE, BUILD_COMMIT);
export const BUILD_REPO_URL = gitHubRepoUrl(BUILD_REPO_REMOTE);
export const BUILD_REPO_LABEL = formatRepoLabel(BUILD_REPO_REMOTE);
