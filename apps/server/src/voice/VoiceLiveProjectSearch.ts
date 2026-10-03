import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/**
 * Resolves a project the user named out loud into concrete (environment,
 * project) targets. Matching is deliberately forgiving — spoken names lose
 * case, punctuation, and hyphens — and the resolution tells the voice model
 * how confident it may be before acting.
 */

export interface VoiceLiveProjectCandidate {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export type VoiceLiveProjectMatchKind = "exact" | "partial";

export interface VoiceLiveProjectMatch extends VoiceLiveProjectCandidate {
  readonly matchKind: VoiceLiveProjectMatchKind;
}

export type VoiceLiveProjectResolution =
  | "unique_exact"
  | "ambiguous_exact"
  | "unique_partial"
  | "ambiguous_partial"
  | "none";

export interface VoiceLiveProjectSearchResult {
  readonly resolution: VoiceLiveProjectResolution;
  readonly matches: ReadonlyArray<VoiceLiveProjectMatch>;
}

/** Case, punctuation, hyphens, and spacing all vanish in speech. */
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const basename = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
};

export function searchVoiceLiveProjects(
  query: string,
  candidates: ReadonlyArray<VoiceLiveProjectCandidate>,
): VoiceLiveProjectSearchResult {
  const needle = normalize(query);
  if (needle.length === 0) {
    return { resolution: "none", matches: [] };
  }

  const exact: VoiceLiveProjectMatch[] = [];
  const partial: VoiceLiveProjectMatch[] = [];
  for (const candidate of candidates) {
    const names = [normalize(candidate.title), normalize(basename(candidate.workspaceRoot))];
    if (names.includes(needle)) {
      exact.push({ ...candidate, matchKind: "exact" });
    } else if (names.some((name) => name.includes(needle))) {
      partial.push({ ...candidate, matchKind: "partial" });
    }
  }

  const byLabelThenTitle = (left: VoiceLiveProjectMatch, right: VoiceLiveProjectMatch) =>
    left.hostLabel.localeCompare(right.hostLabel) || left.title.localeCompare(right.title);

  if (exact.length > 0) {
    return {
      resolution: exact.length === 1 ? "unique_exact" : "ambiguous_exact",
      matches: exact.toSorted(byLabelThenTitle),
    };
  }
  if (partial.length > 0) {
    return {
      resolution: partial.length === 1 ? "unique_partial" : "ambiguous_partial",
      matches: partial.toSorted(byLabelThenTitle),
    };
  }
  return { resolution: "none", matches: [] };
}
