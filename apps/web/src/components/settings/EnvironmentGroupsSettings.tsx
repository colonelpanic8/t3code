import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function EnvironmentGroupsSettings() {
  const state = useAtomValue(environmentCatalog.groups.stateAtom);
  const catalog = useAtomValue(environmentCatalog.unfilteredCatalogValueAtom);
  const setVisible = useAtomCommand(environmentCatalog.groups.setVisible);
  const reset = useAtomCommand(environmentCatalog.groups.resetVisibility);
  const importDocument = useAtomCommand(environmentCatalog.groups.importDocument);
  const refresh = useAtomRefresh(environmentCatalog.groups.definitionsAtom);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <SettingsSection
      id="environment-groups"
      title="Environment groups"
      headerAction={
        <div className="flex gap-2">
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={state.overrides.size === 0}
            onClick={() => void reset()}
          >
            Reset visibility
          </Button>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={importing}
            onClick={() => fileInput.current?.click()}
          >
            Import groups
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">
        Show or hide groups for this session. Connections and running work stay active. Reloading or
        restarting restores the declared defaults.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Import environment groups"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setImporting(true);
          setError(null);
          try {
            const result = await importDocument(await file.text());
            if (result._tag === "Failure") {
              const cause = squashAtomCommandFailure(result);
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not read the group file.");
          } finally {
            setImporting(false);
          }
        }}
      />
      {state.failed ? (
        <SettingsRow
          title="Could not load environment groups"
          description="Retry to restore your configured visibility."
          control={<Button onClick={refresh}>Retry</Button>}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {Object.entries(state.groups).map(([id, group]) => {
        const visible = state.overrides.get(id) ?? group.defaultVisible;
        const known = group.environmentIds.filter((environmentId) =>
          catalog.entries.has(environmentId),
        ).length;
        return (
          <SettingsRow
            key={id}
            title={group.label}
            description={`${known} of ${group.environmentIds.length} environments saved here · ${group.defaultVisible ? "Visible" : "Hidden"} by default`}
            control={
              <Switch
                checked={visible}
                aria-label={`Show ${group.label} for this session`}
                onCheckedChange={(visible) => void setVisible({ groupId: id, visible })}
              />
            }
          />
        );
      })}
      {state.isReady && Object.keys(state.groups).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Import a group declaration or set environmentGroups in your client settings.
        </p>
      ) : null}
    </SettingsSection>
  );
}
