import type { EnvironmentId, ServerFleetEnvironment } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { Fragment, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { pickFleetImportFile } from "./fleetImportFile";

/**
 * Lists the machines of an imported fleet file so the user can pair one of
 * them at its declared address. The list lives only on this screen: importing
 * saves nothing and contacts nothing. A machine already saved links to its
 * settings instead, and is never re-paired from here.
 */
export function FleetImportSection(props: {
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onSelect: (environment: ServerFleetEnvironment) => void;
  readonly onClearSelection: () => void;
  readonly onOpenSaved: (environmentId: EnvironmentId) => void;
}) {
  const [environments, setEnvironments] = useState<ReadonlyArray<ServerFleetEnvironment> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    setImporting(true);
    try {
      const result = await pickFleetImportFile();
      if (result === null) return;
      if (Result.isSuccess(result)) {
        setEnvironments(result.success);
        setError(null);
      } else {
        setEnvironments(null);
        setError(result.failure);
      }
    } finally {
      setImporting(false);
    }
  };

  const handleClear = () => {
    setEnvironments(null);
    setError(null);
    props.onClearSelection();
  };

  if (environments === null) {
    return (
      <View collapsable={false} className="gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={importing}
          onPress={() => void handleImport()}
          className="min-h-13 flex-row items-center gap-3 rounded-[26px] border-continuous bg-grouped-card px-4 active:opacity-70"
        >
          <SymbolView
            name="doc.text"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <View className="min-w-0 flex-1 py-3">
            <Text className="text-base text-foreground">Import fleet file</Text>
            <Text className="text-sm text-foreground-muted">
              Choose a machine from your fleet, then pair it with its code.
            </Text>
          </View>
        </Pressable>
        {error ? (
          <Text accessibilityLiveRegion="polite" className="px-4 text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View collapsable={false} className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">From fleet file</Text>
        <Pressable accessibilityRole="button" onPress={handleClear} hitSlop={8}>
          <Text className="text-sm font-t3-medium text-foreground-muted">Clear</Text>
        </Pressable>
      </View>
      <View
        collapsable={false}
        className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card"
      >
        {environments.map((environment, index) => {
          const saved = props.savedEnvironmentIds.has(environment.environmentId);
          const selected = !saved && props.selectedEnvironmentId === environment.environmentId;
          return (
            <Fragment key={environment.environmentId}>
              {index > 0 ? <View className="ml-4 border-t border-border-subtle" /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => {
                  if (saved) props.onOpenSaved(environment.environmentId);
                  else if (selected) props.onClearSelection();
                  else props.onSelect(environment);
                }}
                className="min-h-13 flex-row items-center gap-3 px-4 active:opacity-70"
              >
                <View className="min-w-0 flex-1 py-3">
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {environment.label}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {environment.httpBaseUrl}
                  </Text>
                </View>
                {saved ? (
                  <>
                    <Text className="text-sm text-foreground-muted">Already saved</Text>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                      weight="semibold"
                    />
                  </>
                ) : selected ? (
                  <SymbolView
                    name="checkmark"
                    size={14}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                    weight="semibold"
                  />
                ) : null}
              </Pressable>
            </Fragment>
          );
        })}
      </View>
      <Text className="px-4 text-sm leading-normal text-foreground-muted">
        {props.selectedEnvironmentId === null
          ? "Choose a machine to pair."
          : "Enter the pairing code shown on that machine below."}
      </Text>
    </View>
  );
}
