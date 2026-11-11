// @effect-diagnostics nodeBuiltinImport:off - Build configs read this before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

/** An ISO date, from epoch seconds (Nix's lastModified) or else Git when the commit is present. */
function resolveCommitDate(commit: string, commitDate: string | undefined): string | null {
  const given = commitDate?.trim();
  if (given) return /^\d+$/.test(given) ? new Date(Number(given) * 1000).toISOString() : given;
  try {
    return (
      NodeChildProcess.execFileSync("git", ["show", "-s", "--format=%cI", commit], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The fork-assembler provenance record as JSON, or "" outside an assembly build. The commit
 * holding the record cannot name itself, so the packager passes it and its date separately.
 */
export function readAssemblyBuild(
  commit: string | undefined,
  commitDate: string | undefined,
): string {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "stack-build-info.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const resolvedCommit = commit?.trim() || null;
  return JSON.stringify({
    ...JSON.parse(raw),
    commit: resolvedCommit,
    commitDate: resolvedCommit ? resolveCommitDate(resolvedCommit, commitDate) : null,
  });
}
