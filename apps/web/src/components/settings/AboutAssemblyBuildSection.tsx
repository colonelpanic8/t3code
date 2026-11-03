import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  type AssemblyBuild,
  assemblyEntryRemote,
  githubBranchUrl,
  githubCommitUrl,
  githubCompareUrl,
  githubPullRequestUrl,
  shortCommit,
} from "../../assemblyBuild";
import { InlineButton } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function ExternalLink({
  href,
  tone = "muted",
  children,
}: {
  href: string | null;
  tone?: "default" | "muted";
  children: ReactNode;
}) {
  if (href === null) return <span>{children}</span>;
  return (
    <InlineButton tone={tone} render={<a href={href} target="_blank" rel="noreferrer noopener" />}>
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </InlineButton>
  );
}

function CommitLink({ remote, commit }: { remote: string | null | undefined; commit: string }) {
  return (
    <ExternalLink href={githubCommitUrl(remote, commit)} tone="default">
      <code className="text-xs">{shortCommit(commit)}</code>
    </ExternalLink>
  );
}

export function AboutAssemblyBuildSection({ build }: { build: AssemblyBuild }) {
  const forkRemote = build.fork?.remote ?? null;
  const { upstream } = build;
  const upstreamDetails = [
    upstream.subject,
    upstream.tag,
    upstream.date ? new Date(upstream.date).toLocaleString() : undefined,
  ].filter((detail) => detail !== undefined && detail !== "");

  return (
    <SettingsSection id="assembly-build" title="Assembly build">
      <SettingsRow
        title="Assembled commit"
        description={
          build.commit === null ? (
            "This build was not made from a published commit."
          ) : (
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              {build.fork ? (
                <span>
                  Published to{" "}
                  <ExternalLink href={githubBranchUrl(forkRemote, build.fork.branch)}>
                    {build.fork.branch}
                  </ExternalLink>
                </span>
              ) : null}
              <ExternalLink href={githubCompareUrl(forkRemote, upstream.commit, build.commit)}>
                Diff from upstream
              </ExternalLink>
            </span>
          )
        }
        control={
          build.commit === null ? null : <CommitLink remote={forkRemote} commit={build.commit} />
        }
      />
      <SettingsRow
        title={
          <span>
            Upstream base{" "}
            <ExternalLink href={githubBranchUrl(upstream.remote, upstream.ref)}>
              {upstream.ref}
            </ExternalLink>
          </span>
        }
        description={upstreamDetails.join(" · ")}
        control={<CommitLink remote={upstream.remote} commit={upstream.commit} />}
      />
      <SettingsRow
        title={`Carried branches (${build.entries.length})`}
        description="Merged in this order on top of the upstream base."
      >
        <ol className="divide-y divide-border/60 py-1">
          {build.entries.map((entry) => {
            const remote = assemblyEntryRemote(build, entry);
            return (
              <li key={entry.label} className="flex items-start justify-between gap-4 py-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    {entry.branch ? (
                      <ExternalLink href={githubBranchUrl(remote, entry.branch)}>
                        {entry.branch}
                      </ExternalLink>
                    ) : (
                      <span className="text-muted-foreground">{entry.label}</span>
                    )}
                    {entry.pr === undefined ? null : (
                      <ExternalLink href={githubPullRequestUrl(upstream.remote, entry.pr)}>
                        #{entry.pr}
                      </ExternalLink>
                    )}
                    {entry.status === "merged" ? null : (
                      <span className="text-xs text-warning">{entry.status}</span>
                    )}
                  </div>
                  {entry.summary ? (
                    <p className="text-xs text-muted-foreground">{entry.summary}</p>
                  ) : null}
                </div>
                {entry.commit ? <CommitLink remote={remote} commit={entry.commit} /> : null}
              </li>
            );
          })}
        </ol>
      </SettingsRow>
    </SettingsSection>
  );
}
