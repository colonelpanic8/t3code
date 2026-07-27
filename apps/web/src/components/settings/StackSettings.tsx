import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { APP_VERSION } from "../../branding";
import {
  BUILD_COMMIT,
  BUILD_COMMIT_SHORT,
  BUILD_COMMIT_URL,
  BUILD_DATE,
  BUILD_DIRTY,
  BUILD_REPO_LABEL,
} from "../../buildProvenance";
import { formatCommitDate, formatRepoLabel, shortCommit } from "../../buildProvenance.logic";
import {
  countStack,
  entryBranchUrl,
  entryCommitUrl,
  entryPullRequestUrl,
  upstreamCommitUrl,
  type StackEntry,
  type StackEntryKind,
  type StackEntryStatus,
  type StackProvenance,
} from "../../stackProvenance.logic";
import { STACK_PROVENANCE } from "../../stackProvenance";
import { cn } from "../../lib/utils";
import { ExternalLink } from "../ExternalLink";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const KIND_LABELS: Record<StackEntryKind, string> = {
  fork: "PR branch",
  local: "Local only",
  external: "External PR",
  epilogue: "Patch",
};

/**
 * "merged" is the ordinary outcome and would be noise on every row, so only the
 * outcomes that mean the entry is a drop candidate get a badge.
 */
const STATUS_LABELS: Partial<Record<StackEntryStatus, string>> = {
  absorbed: "Already upstream",
  empty: "Changed nothing",
};

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px]">{children}</span>;
}

function ThisBuildSection() {
  const repoLabel = BUILD_REPO_LABEL ?? "an unknown repository";
  const commitDate = formatCommitDate(BUILD_DATE);

  return (
    <SettingsSection title="This build">
      <dl className="space-y-2.5 px-3 sm:px-4">
        <FieldRow label="Version">
          <Mono>{APP_VERSION}</Mono>
        </FieldRow>
        {BUILD_COMMIT ? (
          <FieldRow label="Commit">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {BUILD_COMMIT_URL ? (
                <ExternalLink href={BUILD_COMMIT_URL} className="font-mono text-[12px]">
                  {BUILD_COMMIT_SHORT}
                </ExternalLink>
              ) : (
                <Mono>{BUILD_COMMIT_SHORT}</Mono>
              )}
              <span className="text-muted-foreground/80">in {repoLabel}</span>
              {BUILD_DIRTY ? (
                <Badge variant="warning" size="sm">
                  Uncommitted changes
                </Badge>
              ) : null}
            </span>
          </FieldRow>
        ) : null}
        {commitDate ? <FieldRow label="Committed">{commitDate}</FieldRow> : null}
      </dl>
    </SettingsSection>
  );
}

function UpstreamSection({ provenance }: { provenance: StackProvenance }) {
  const { upstream } = provenance;
  const commitUrl = upstreamCommitUrl(upstream);
  const repoLabel = formatRepoLabel(upstream.remote);
  const date = formatCommitDate(upstream.date);

  return (
    <SettingsSection title="Upstream base">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Everything below was merged onto this commit. It carries all of upstream&rsquo;s history up
        to that point; only the changes listed here are additional.
      </p>
      <dl className="mt-3 space-y-2.5 px-3 sm:px-4">
        <FieldRow label="Repository">
          {repoLabel ? (
            <>
              {repoLabel}
              <span className="text-muted-foreground/80"> · {upstream.ref}</span>
            </>
          ) : (
            <span className="text-muted-foreground/80">Unknown</span>
          )}
        </FieldRow>
        <FieldRow label="Commit">
          {commitUrl ? (
            <ExternalLink href={commitUrl} className="font-mono text-[12px]">
              {shortCommit(upstream.commit)}
            </ExternalLink>
          ) : (
            <Mono>{shortCommit(upstream.commit)}</Mono>
          )}
        </FieldRow>
        {upstream.subject ? <FieldRow label="Subject">{upstream.subject}</FieldRow> : null}
        {date ? <FieldRow label="Committed">{date}</FieldRow> : null}
      </dl>
    </SettingsSection>
  );
}

function EntryNote({ note }: { note: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
        aria-expanded={isExpanded}
      >
        {isExpanded ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        Why it is carried
      </button>
      {isExpanded ? (
        <p className="mt-1 max-w-2xl whitespace-pre-wrap text-[12px] leading-[1.5] text-muted-foreground/80">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function EntryRow({
  entry,
  provenance,
  isNested = false,
}: {
  entry: StackEntry;
  provenance: StackProvenance;
  isNested?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const pullRequestUrl = entryPullRequestUrl(entry, provenance.upstream.remote);
  const branchUrl = entryBranchUrl(entry, provenance.fork.remote);
  const commitUrl = entryCommitUrl(entry, provenance.upstream.remote, provenance.fork.remote);
  const statusLabel = STATUS_LABELS[entry.status];
  const hasMembers = entry.entries.length > 0;

  return (
    <div className={cn("py-2.5", isNested && "border-l border-border/60 pl-4")}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {pullRequestUrl ? (
          <ExternalLink href={pullRequestUrl} className="font-mono text-[12px] font-medium">
            {entry.label}
          </ExternalLink>
        ) : (
          <span className="font-mono text-[12px] font-medium break-all">{entry.label}</span>
        )}
        <Badge variant="outline" size="sm">
          {KIND_LABELS[entry.kind]}
        </Badge>
        {statusLabel ? (
          <Badge variant="warning" size="sm">
            {statusLabel}
          </Badge>
        ) : null}
        {commitUrl ? (
          <ExternalLink
            href={commitUrl}
            className="ml-auto font-mono text-[11px] text-muted-foreground"
          >
            {shortCommit(entry.commit)}
          </ExternalLink>
        ) : null}
      </div>

      {entry.summary ? (
        <p className="mt-1 max-w-2xl text-[13px] leading-[1.45] text-foreground/90">
          {entry.summary}
        </p>
      ) : null}

      {entry.branch ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
          {branchUrl ? (
            <ExternalLink href={branchUrl} className="font-mono">
              {entry.branch}
            </ExternalLink>
          ) : (
            <span className="font-mono">{entry.branch}</span>
          )}
        </p>
      ) : null}

      {entry.note ? <EntryNote note={entry.note} /> : null}

      {hasMembers ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setIsExpanded((expanded) => !expanded)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            {entry.entries.length} changes in this group
          </button>
          {isExpanded ? (
            <div className="mt-1">
              {entry.entries.map((member) => (
                <EntryRow
                  key={`${member.label}:${member.commit}`}
                  entry={member}
                  provenance={provenance}
                  isNested
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CarriedSection({ provenance }: { provenance: StackProvenance }) {
  const counts = countStack(provenance.entries);
  const forkLabel = formatRepoLabel(provenance.fork.remote);

  const summary = [
    `${counts.changes} ${counts.changes === 1 ? "change" : "changes"}`,
    counts.pullRequests > 0 ? `${counts.pullRequests} pull requests` : null,
    counts.epilogues > 0 ? `${counts.epilogues} stack-only patches` : null,
    counts.inert > 0 ? `${counts.inert} now inert` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsSection title="Carried on top">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        {summary}
        {forkLabel ? (
          <>
            , merged in this order onto{" "}
            <span className="font-mono text-[12px]">{provenance.fork.branch}</span> in {forkLabel}.
          </>
        ) : (
          "."
        )}
      </p>
      <div className="mt-2 divide-y divide-border/60 px-3 sm:px-4">
        {provenance.entries.map((entry) => (
          <EntryRow key={`${entry.label}:${entry.commit}`} entry={entry} provenance={provenance} />
        ))}
      </div>
    </SettingsSection>
  );
}

function NoStackSection() {
  return (
    <SettingsSection title="Carried on top">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        This build carries no assembled stack — it was built straight from a checkout rather than
        from an integration branch, so there is nothing on top of upstream to list.
      </p>
    </SettingsSection>
  );
}

export function StackSettings() {
  return (
    <SettingsPageContainer>
      <ThisBuildSection />
      {STACK_PROVENANCE ? (
        <>
          <UpstreamSection provenance={STACK_PROVENANCE} />
          <CarriedSection provenance={STACK_PROVENANCE} />
        </>
      ) : (
        <NoStackSection />
      )}
    </SettingsPageContainer>
  );
}
