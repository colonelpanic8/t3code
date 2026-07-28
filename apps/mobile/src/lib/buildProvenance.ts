import Constants from "expo-constants";

import {
  formatRepoLabel,
  gitHubCommitUrl,
  gitHubRepoUrl,
  shortCommit,
} from "@t3tools/shared/buildProvenance";
import { parseStackProvenance } from "@t3tools/shared/stackProvenance";

/**
 * Which commit of which repository this bundle was built from, and what stack
 * it was assembled from.
 *
 * The app version answers "which release line is this"; it cannot answer "is
 * this the build with the fix I just merged", because every build off a given
 * version shares it. `apps/mobile/app.config.ts` reads these at build time
 * through the same helper `apps/web/vite.config.ts` uses, and puts them in the
 * Expo config's `extra`, which is the only channel that survives both a local
 * `expo run` and an EAS build.
 *
 * Every value is optional. A build with no provenance is normal, so consumers
 * must render its absence rather than a placeholder commit.
 */

interface EmbeddedBuild {
  readonly commit?: unknown;
  readonly repoRemote?: unknown;
  readonly date?: unknown;
  readonly dirty?: unknown;
  readonly stackBuildInfo?: unknown;
}

const embedded = (Constants.expoConfig?.extra?.build ?? {}) as EmbeddedBuild;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const BUILD_COMMIT = text(embedded.commit);
export const BUILD_REPO_REMOTE = text(embedded.repoRemote);

/** ISO 8601 committer date of `BUILD_COMMIT`, not the moment of the build. */
export const BUILD_DATE = text(embedded.date);

/** Tracked files differed from `BUILD_COMMIT` when the bundle was built. */
export const BUILD_DIRTY = embedded.dirty === true;

export const BUILD_COMMIT_SHORT = shortCommit(BUILD_COMMIT);
export const BUILD_COMMIT_URL = gitHubCommitUrl(BUILD_REPO_REMOTE, BUILD_COMMIT);
export const BUILD_REPO_URL = gitHubRepoUrl(BUILD_REPO_REMOTE);
export const BUILD_REPO_LABEL = formatRepoLabel(BUILD_REPO_REMOTE);

/**
 * What this build is assembled from, when it was assembled by the stack
 * rebuild. Null for an ordinary build of a plain checkout, which is most of
 * them -- there is no stack to describe.
 */
export const STACK_PROVENANCE = parseStackProvenance(text(embedded.stackBuildInfo));
