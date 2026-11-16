import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Badge } from "../ui/badge";
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
        <div className="flex items-center gap-1">
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
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
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
          }
          setImporting(false);
        }}
      />
      {state.failed ? (
        <SettingsRow
          title="Could not load environment groups"
          description="Retry to restore your configured visibility."
          control={<Button onClick={refresh}>Retry</Button>}
        />
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-2.5 text-xs text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {Object.entries(state.groups).map(([id, group]) => {
        const visible = state.overrides.get(id) ?? group.defaultVisible;
        const total = group.environmentIds.length;
        const missing =
          total -
          group.environmentIds.filter((environmentId) => catalog.entries.has(environmentId)).length;
        return (
          <SettingsRow
            key={id}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{group.label}</span>
                <Badge variant="outline" size="sm">
                  {group.defaultVisible ? "Shown" : "Hidden"} by default
                </Badge>
              </span>
            }
            description={`${total} ${total === 1 ? "environment" : "environments"}${missing > 0 ? ` · ${missing} not saved on this device` : ""}`}
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
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Import a group declaration or set environmentGroups in your client settings.
        </p>
      ) : null}
    </SettingsSection>
  );
}
