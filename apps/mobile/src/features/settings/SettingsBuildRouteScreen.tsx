import Constants from "expo-constants";
import { SymbolView } from "expo-symbols";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatCommitDate, formatRepoLabel, shortCommit } from "@t3tools/shared/buildProvenance";
import {
  countStack,
  entryBranchUrl,
  entryCommitUrl,
  entryPullRequestUrl,
  upstreamCommitUrl,
  type StackEntry,
  type StackProvenance,
} from "@t3tools/shared/stackProvenance";

import { AppText as Text } from "../../components/AppText";
import {
  BUILD_COMMIT,
  BUILD_COMMIT_SHORT,
  BUILD_COMMIT_URL,
  BUILD_DATE,
  BUILD_DIRTY,
  BUILD_REPO_LABEL,
  STACK_PROVENANCE,
} from "../../lib/buildProvenance";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThemeColor } from "../../lib/useThemeColor";
import { SettingsSection } from "./components/SettingsSection";

/** A label/value pair. `url` turns the value into a link out to GitHub. */
function FieldRow(props: {
  readonly label: string;
  readonly value: string;
  readonly url?: string | null;
  readonly mono?: boolean;
  readonly first?: boolean;
}) {
  const link = useThemeColor("--color-link");
  const valueClass = props.mono
    ? "text-right text-base font-mono text-foreground"
    : "text-right text-base text-foreground";

  return (
    <View
      className={
        props.first
          ? "flex-row items-baseline gap-4 px-4 py-3"
          : "flex-row items-baseline gap-4 border-t border-border/50 px-4 py-3"
      }
    >
      <Text className="shrink-0 text-base text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 items-end">
        {props.url ? (
          <Pressable onPress={() => void tryOpenExternalUrl(props.url ?? "", "build-provenance")}>
            <Text className={valueClass} style={{ color: link }} numberOfLines={1}>
              {props.value}
            </Text>
          </Pressable>
        ) : (
          <Text className={valueClass} numberOfLines={2}>
            {props.value}
          </Text>
        )}
      </View>
    </View>
  );
}

function ThisBuildSection() {
  const version = Constants.expoConfig?.version ?? "0.0.0";
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const commitDate = formatCommitDate(BUILD_DATE);

  return (
    <SettingsSection title="This build">
      <FieldRow first label="Version" value={version} />
      <FieldRow label="Variant" value={variant} />
      {BUILD_COMMIT ? (
        <FieldRow
          mono
          label="Commit"
          value={BUILD_DIRTY ? `${BUILD_COMMIT_SHORT} (modified)` : BUILD_COMMIT_SHORT}
          url={BUILD_COMMIT_URL}
        />
      ) : (
        <FieldRow label="Commit" value="No record" />
      )}
      {BUILD_REPO_LABEL ? <FieldRow label="Repository" value={BUILD_REPO_LABEL} /> : null}
      {commitDate ? <FieldRow label="Committed" value={commitDate} /> : null}
    </SettingsSection>
  );
}

function UpstreamSection({ provenance }: { readonly provenance: StackProvenance }) {
  const { upstream } = provenance;
  const repoLabel = formatRepoLabel(upstream.remote);
  const date = formatCommitDate(upstream.date);

  return (
    <SettingsSection title="Upstream base">
      {repoLabel ? <FieldRow first label="Repository" value={repoLabel} /> : null}
      <FieldRow
        first={!repoLabel}
        mono
        label="Commit"
        value={shortCommit(upstream.commit)}
        url={upstreamCommitUrl(upstream)}
      />
      {upstream.subject ? <FieldRow label="Subject" value={upstream.subject} /> : null}
      {date ? <FieldRow label="Committed" value={date} /> : null}
    </SettingsSection>
  );
}

function EntryRow(props: {
  readonly entry: StackEntry;
  readonly provenance: StackProvenance;
  readonly first: boolean;
  readonly nested?: boolean;
}) {
  const { entry, provenance } = props;
  const link = useThemeColor("--color-link");
  const url =
    entryPullRequestUrl(entry, provenance.upstream.remote) ??
    entryBranchUrl(entry, provenance.fork.remote) ??
    entryCommitUrl(entry, provenance.fork.remote, provenance.upstream.remote);
  // "merged" is the ordinary outcome and would be noise on every row; the
  // others mean the entry contributed nothing, which is worth seeing.
  const status = entry.status === "merged" ? null : entry.status;

  return (
    <View
      className={[
        props.first ? "px-4 py-3" : "border-t border-border/50 px-4 py-3",
        props.nested ? "pl-8" : "",
      ].join(" ")}
    >
      <View className="flex-row items-baseline gap-3">
        {url ? (
          <Pressable onPress={() => void tryOpenExternalUrl(url, "build-provenance")}>
            <Text className="text-base font-mono" style={{ color: link }}>
              {entry.label}
            </Text>
          </Pressable>
        ) : (
          <Text className="text-base font-mono text-foreground">{entry.label}</Text>
        )}
        <View className="min-w-0 flex-1 items-end">
          <Text className="text-sm text-foreground-muted">
            {status ? `${entry.kind} · ${status}` : entry.kind}
          </Text>
        </View>
      </View>
      {entry.summary ? (
        <Text className="mt-1 text-sm leading-5 text-foreground-muted">{entry.summary}</Text>
      ) : null}
      {entry.entries.map((child, index) => (
        <EntryRow
          key={`${child.label}:${child.commit}`}
          entry={child}
          provenance={provenance}
          first={index === 0}
          nested
        />
      ))}
    </View>
  );
}

function CarriedSection({ provenance }: { readonly provenance: StackProvenance }) {
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
    <View className="gap-2">
      <Text className="px-2 text-sm font-t3-medium text-foreground-muted">Carried on top</Text>
      <Text className="px-2 text-sm leading-5 text-foreground-muted/80">
        {forkLabel
          ? `${summary}, merged in this order onto ${provenance.fork.branch} in ${forkLabel}.`
          : `${summary}.`}
      </Text>
      <View className="overflow-hidden rounded-[24px] border-continuous bg-card">
        {provenance.entries.map((entry, index) => (
          <EntryRow
            key={`${entry.label}:${entry.commit}`}
            entry={entry}
            provenance={provenance}
            first={index === 0}
          />
        ))}
      </View>
    </View>
  );
}

function NoStackSection() {
  const icon = useThemeColor("--color-icon");
  return (
    <SettingsSection title="Carried on top">
      <View className="items-center gap-2 px-6 py-8">
        <SymbolView name="shippingbox" size={28} tintColor={icon} type="monochrome" />
        <Text className="text-center text-sm leading-5 text-foreground-muted">
          This build carries no assembled stack — it was built straight from a checkout rather than
          from an integration branch, so there is nothing on top of upstream to list.
        </Text>
      </View>
    </SettingsSection>
  );
}

export function SettingsBuildRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        <ThisBuildSection />
        {STACK_PROVENANCE ? (
          <>
            <UpstreamSection provenance={STACK_PROVENANCE} />
            <CarriedSection provenance={STACK_PROVENANCE} />
          </>
        ) : (
          <NoStackSection />
        )}
      </ScrollView>
    </View>
  );
}
