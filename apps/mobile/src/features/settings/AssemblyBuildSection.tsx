import {
  type AssemblyBuild,
  assemblyEntryRemote,
  githubBranchUrl,
  githubCommitUrl,
  githubCompareUrl,
  githubPullRequestUrl,
  parseAssemblyBuild,
  formatCommitDate,
  shortCommit,
} from "@t3tools/client-runtime/assembly-build";
import Constants from "expo-constants";
import type { ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";

const extraAssemblyBuild: unknown = Constants.expoConfig?.extra?.assemblyBuild;
const ASSEMBLY_BUILD =
  typeof extraAssemblyBuild === "string" ? parseAssemblyBuild(extraAssemblyBuild) : null;

function GitHubLink({
  url,
  className,
  children,
}: {
  url: string | null;
  className?: string;
  children: ReactNode;
}) {
  if (url === null) {
    return <Text className={`text-foreground-muted ${className ?? ""}`}>{children}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
    >
      <Text className={`text-primary ${className ?? ""}`}>{children}</Text>
    </Pressable>
  );
}

function CommitLink({
  remote,
  commit,
  date,
}: {
  remote: string | null | undefined;
  commit: string;
  date: string | null | undefined;
}) {
  const formattedDate = formatCommitDate(date);
  return (
    <View className="items-end gap-0.5">
      <GitHubLink url={githubCommitUrl(remote, commit)} className="font-mono text-sm">
        {shortCommit(commit)}
      </GitHubLink>
      {formattedDate ? (
        <Text className="text-xs text-foreground-muted">{formattedDate}</Text>
      ) : null}
    </View>
  );
}

function BuildRow({
  first,
  title,
  commit,
  children,
}: {
  first?: boolean;
  title: ReactNode;
  commit: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View className={first ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-baseline gap-x-2">{title}</View>
        {commit}
      </View>
      {children}
    </View>
  );
}

function AssemblyBuildCards({ build }: { build: AssemblyBuild }) {
  const forkRemote = build.fork?.remote ?? null;
  const { upstream } = build;
  const upstreamDetails = [upstream.subject, upstream.tag].filter(
    (detail) => detail !== undefined && detail !== "",
  );

  return (
    <>
      <SettingsSection title="Assembly build">
        <BuildRow
          first
          title={<Text className="text-base text-foreground">Assembled commit</Text>}
          commit={
            build.commit === null ? null : (
              <CommitLink remote={forkRemote} commit={build.commit} date={build.commitDate} />
            )
          }
        >
          {build.commit === null ? (
            <Text className="text-sm text-foreground-muted">
              This build was not made from a published commit.
            </Text>
          ) : (
            <View className="flex-row flex-wrap gap-x-3">
              {build.fork ? (
                <GitHubLink
                  url={githubBranchUrl(forkRemote, build.fork.branch)}
                  className="text-sm"
                >
                  {build.fork.branch}
                </GitHubLink>
              ) : null}
              <GitHubLink
                url={githubCompareUrl(forkRemote, upstream.commit, build.commit)}
                className="text-sm"
              >
                Diff from upstream
              </GitHubLink>
            </View>
          )}
        </BuildRow>
        <BuildRow
          title={
            <>
              <Text className="text-base text-foreground">Upstream base</Text>
              <GitHubLink url={githubBranchUrl(upstream.remote, upstream.ref)} className="text-sm">
                {upstream.ref}
              </GitHubLink>
            </>
          }
          commit={
            <CommitLink remote={upstream.remote} commit={upstream.commit} date={upstream.date} />
          }
        >
          <Text className="text-sm text-foreground-muted">{upstreamDetails.join(" · ")}</Text>
        </BuildRow>
      </SettingsSection>

      <SettingsSection
        title={`Carried branches (${build.entries.length})`}
        footer="Merged in this order on top of the upstream base."
      >
        {build.entries.map((entry, index) => {
          const remote = assemblyEntryRemote(build, entry);
          return (
            <BuildRow
              key={entry.label}
              first={index === 0}
              title={
                <>
                  {entry.branch ? (
                    <GitHubLink url={githubBranchUrl(remote, entry.branch)} className="text-sm">
                      {entry.branch}
                    </GitHubLink>
                  ) : (
                    <Text className="text-sm text-foreground-muted">{entry.label}</Text>
                  )}
                  {entry.pr === undefined ? null : (
                    <GitHubLink
                      url={githubPullRequestUrl(upstream.remote, entry.pr)}
                      className="text-sm"
                    >
                      #{entry.pr}
                    </GitHubLink>
                  )}
                  {entry.status === "merged" ? null : (
                    <Text className="text-xs text-warning-foreground">{entry.status}</Text>
                  )}
                </>
              }
              commit={
                entry.commit ? (
                  <CommitLink remote={remote} commit={entry.commit} date={entry.date} />
                ) : null
              }
            >
              {entry.summary ? (
                <Text className="text-xs text-foreground-muted">{entry.summary}</Text>
              ) : null}
            </BuildRow>
          );
        })}
      </SettingsSection>
    </>
  );
}

export function AssemblyBuildSection() {
  return ASSEMBLY_BUILD ? <AssemblyBuildCards build={ASSEMBLY_BUILD} /> : null;
}
