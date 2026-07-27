import { gitHubCommitUrl, gitHubRepoUrl } from "./buildProvenance.logic";

/**
 * Reads `stack-build-info.json`, which the stack rebuild writes as the final
 * commit on the integration branch this app is built from.
 *
 * Nothing validates the file between the generator and here, and it is a
 * diagnostic rather than a load-bearing input, so every parse failure degrades:
 * a malformed entry is dropped, a malformed document yields null, and the page
 * says it has no record instead of throwing away the rest of settings.
 */

export type StackEntryKind = "fork" | "local" | "external" | "epilogue";
export type StackEntryStatus = "merged" | "absorbed" | "empty" | "epilogue";

const KINDS = new Set<string>(["fork", "local", "external", "epilogue"] satisfies StackEntryKind[]);
const STATUSES = new Set<string>([
  "merged",
  "absorbed",
  "empty",
  "epilogue",
] satisfies StackEntryStatus[]);

/** Groups are pinned as a single entry holding a sub-manifest. They do not nest further. */
const MAX_ENTRY_DEPTH = 1;

export interface StackEntry {
  readonly label: string;
  readonly kind: StackEntryKind;
  readonly status: StackEntryStatus;
  readonly commit: string;
  readonly pr: number | null;
  readonly branch: string | null;
  readonly ref: string | null;
  readonly summary: string | null;
  readonly note: string | null;
  readonly entries: readonly StackEntry[];
}

export interface StackUpstream {
  readonly remote: string;
  readonly ref: string;
  readonly commit: string;
  readonly subject: string;
  readonly date: string;
}

export interface StackFork {
  readonly remote: string;
  readonly branch: string;
}

export interface StackProvenance {
  readonly schemaVersion: number;
  readonly manifest: string;
  readonly upstream: StackUpstream;
  readonly fork: StackFork;
  readonly entries: readonly StackEntry[];
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEntry(value: unknown, depth: number): StackEntry | null {
  const record = readRecord(value);
  const label = record && readString(record.label);
  if (!record || !label) return null;

  const kind = readString(record.kind);
  const status = readString(record.status);

  return {
    label,
    kind: kind !== null && KINDS.has(kind) ? (kind as StackEntryKind) : "fork",
    status: status !== null && STATUSES.has(status) ? (status as StackEntryStatus) : "merged",
    commit: readString(record.commit) ?? "",
    pr: typeof record.pr === "number" && Number.isInteger(record.pr) ? record.pr : null,
    branch: readString(record.branch),
    ref: readString(record.ref),
    summary: readString(record.summary),
    note: readString(record.note),
    entries: depth > 0 ? parseEntries(record.entries, depth - 1) : [],
  };
}

function parseEntries(value: unknown, depth: number): readonly StackEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseEntry(entry, depth))
    .filter((entry): entry is StackEntry => entry !== null);
}

function parseUpstream(value: unknown): StackUpstream | null {
  const record = readRecord(value);
  const commit = record && readString(record.commit);
  if (!record || !commit) return null;

  return {
    remote: readString(record.remote) ?? "",
    ref: readString(record.ref) ?? "",
    commit,
    subject: readString(record.subject) ?? "",
    date: readString(record.date) ?? "",
  };
}

export function parseStackProvenance(raw: string): StackProvenance | null {
  if (raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = readRecord(parsed);
  const upstream = record && parseUpstream(record.upstream);
  if (!record || !upstream) return null;

  const fork = readRecord(record.fork);

  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 0,
    manifest: readString(record.manifest) ?? "",
    upstream,
    fork: {
      remote: (fork && readString(fork.remote)) ?? "",
      branch: (fork && readString(fork.branch)) ?? "",
    },
    entries: parseEntries(record.entries, MAX_ENTRY_DEPTH),
  };
}

/**
 * Pull requests are always numbered against upstream, even for a topic whose
 * branch lives on the fork -- the PR is the proposal to upstream.
 */
export function entryPullRequestUrl(entry: StackEntry, upstreamRemote: string): string | null {
  const repoUrl = gitHubRepoUrl(upstreamRemote);
  return repoUrl && entry.pr !== null ? `${repoUrl}/pull/${entry.pr}` : null;
}

export function entryBranchUrl(entry: StackEntry, forkRemote: string): string | null {
  const repoUrl = gitHubRepoUrl(forkRemote);
  return repoUrl && entry.branch ? `${repoUrl}/tree/${entry.branch}` : null;
}

/**
 * An external entry is merged from a PR head on upstream, which is the only
 * place that commit is reachable. Everything else is published on the fork.
 */
export function entryCommitUrl(
  entry: StackEntry,
  upstreamRemote: string,
  forkRemote: string,
): string | null {
  return gitHubCommitUrl(entry.kind === "external" ? upstreamRemote : forkRemote, entry.commit);
}

export function upstreamCommitUrl(upstream: StackUpstream): string | null {
  return gitHubCommitUrl(upstream.remote, upstream.commit);
}

export interface StackCounts {
  /** Entries the page shows as rows, groups counted once. */
  readonly rows: number;
  /** Every change carried, groups counted as their members. */
  readonly changes: number;
  readonly pullRequests: number;
  readonly epilogues: number;
  /** Entries upstream already absorbed, or whose merge changed nothing. */
  readonly inert: number;
}

export function countStack(entries: readonly StackEntry[]): StackCounts {
  const flat = entries.flatMap((entry) => (entry.entries.length > 0 ? entry.entries : [entry]));
  const pullRequests = new Set(flat.filter((entry) => entry.pr !== null).map((entry) => entry.pr));

  return {
    rows: entries.length,
    changes: flat.length,
    pullRequests: pullRequests.size,
    epilogues: flat.filter((entry) => entry.kind === "epilogue").length,
    inert: flat.filter((entry) => entry.status === "absorbed" || entry.status === "empty").length,
  };
}
