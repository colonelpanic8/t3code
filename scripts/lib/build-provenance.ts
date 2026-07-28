// @effect-diagnostics nodeBuiltinImport:off - Build configuration; it runs in
// plain Node before any Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Reads, at build time, which commit a bundle came from and what stack it was
 * assembled from. Shared so the web bundle and the mobile bundle describe
 * themselves identically -- two readers drifted apart is exactly the failure
 * the Build page exists to make visible.
 *
 * Every field is optional. A build with no provenance is normal (an ordinary
 * checkout, a source tarball), so consumers must render its absence rather than
 * invent a placeholder.
 */

/**
 * Resolved from this file rather than the caller's cwd: `app.config.ts` is
 * transpiled by Expo into a module scope where `import.meta` is unavailable, so
 * callers cannot compute it themselves.
 */
export const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export interface BuildProvenance {
  readonly commit: string;
  readonly repoRemote: string;
  /** ISO 8601 committer date of `commit`, not the moment of the build. */
  readonly date: string;
  /** Tracked files differed from `commit` when the bundle was built. */
  readonly dirty: boolean;
  /** `stack-build-info.json` re-serialized, or "" when this is not an assembled build. */
  readonly stackBuildInfo: string;
}

/**
 * Runs git in the repository. A null status covers every way git can be
 * unavailable rather than merely unsuccessful -- not on PATH, no `.git`
 * directory, timed out -- which callers must distinguish from a real non-zero
 * exit. Builds that happen away from a checkout (a Nix sandbox, an unpacked
 * source tarball) are expected, and pass provenance through T3CODE_BUILD_*.
 */
function runGit(
  repoRoot: string,
  ...args: readonly string[]
): { status: number | null; stdout: string } {
  try {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error) return { status: null, stdout: "" };
    return { status: result.status, stdout: result.stdout?.trim() ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}

function readGit(repoRoot: string, ...args: readonly string[]): string {
  const result = runGit(repoRoot, ...args);
  return result.status === 0 ? result.stdout : "";
}

/**
 * The stack rebuild writes `stack-build-info.json` as the integration branch's
 * final commit; a plain checkout has no such file and the Build page says so.
 * Re-serialized to drop formatting, which also fails the build loudly on
 * malformed JSON rather than shipping a bundle whose provenance silently
 * refuses to parse.
 */
export function readStackBuildInfo(repoRoot: string): string {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(repoRoot, "stack-build-info.json"), "utf8");
  } catch {
    return "";
  }
  return JSON.stringify(JSON.parse(raw));
}

/**
 * The fork an assembled build was published from. A sandboxed builder has no
 * git remote to read, and no reason to be told this twice -- the stack record
 * it is building from already names the fork.
 */
function stackForkRemote(stackBuildInfo: string): string {
  if (stackBuildInfo === "") return "";
  try {
    const { fork } = JSON.parse(stackBuildInfo) as { fork?: { remote?: unknown } };
    return typeof fork?.remote === "string" ? fork.remote.trim() : "";
  } catch {
    return "";
  }
}

export function readBuildProvenance(repoRoot: string = REPO_ROOT): BuildProvenance {
  const stackBuildInfo = readStackBuildInfo(repoRoot);

  // Read from git so a plain build is self-describing, overridable so a
  // sandboxed builder can supply what it already knows.
  const commit = process.env.T3CODE_BUILD_COMMIT?.trim() || readGit(repoRoot, "rev-parse", "HEAD");
  const repoRemote =
    process.env.T3CODE_BUILD_REPO_REMOTE?.trim() ||
    readGit(repoRoot, "remote", "get-url", "origin") ||
    stackForkRemote(stackBuildInfo);
  const date =
    process.env.T3CODE_BUILD_DATE?.trim() || readGit(repoRoot, "log", "-1", "--format=%cI");
  const dirty = (() => {
    const override = process.env.T3CODE_BUILD_DIRTY?.trim().toLowerCase();
    if (override) return override === "1" || override === "true";
    // `git diff --quiet` exits 1 for tracked-file changes. Untracked files are
    // deliberately ignored: they are mostly build output and scratch, and
    // finding them costs a stat of the whole worktree.
    return runGit(repoRoot, "diff", "--quiet", "HEAD").status === 1;
  })();

  return { commit, repoRemote, date, dirty, stackBuildInfo };
}
