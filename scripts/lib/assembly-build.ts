// @effect-diagnostics nodeBuiltinImport:off - Build configs read this before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

/**
 * The fork-assembler provenance record as JSON, or "" outside an assembly build. The commit
 * holding the record cannot name itself, so the packager passes it separately.
 */
export function readAssemblyBuild(commit: string | undefined): string {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "stack-build-info.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  return JSON.stringify({ ...JSON.parse(raw), commit: commit?.trim() || null });
}
