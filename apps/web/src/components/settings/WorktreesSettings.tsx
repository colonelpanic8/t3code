import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { DraftInput } from "../ui/draft-input";
import { AdvancedSettings } from "./AdvancedSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function StartFromRemoteRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description="Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing."
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label="new worktrees start from remote"
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label="Start new worktrees from remote by default"
        />
      }
    />
  );
}

function WorktreePathTemplateRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreePathTemplate"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreePathTemplate"]}
      {...searchableSetting("worktree-path")}
      description="Template for new worktrees. Relative paths start at the repository root. Variables: {repoRoot}, {repoName}, {branch}, and {worktreesDir} (the worktree location)."
      resetAction={
        settings.worktreePathTemplate !== DEFAULT_UNIFIED_SETTINGS.worktreePathTemplate ? (
          <SettingResetButton
            label="worktree path"
            onClick={() =>
              updateSettings({
                worktreePathTemplate: DEFAULT_UNIFIED_SETTINGS.worktreePathTemplate,
              })
            }
          />
        ) : null
      }
      control={
        <DraftInput
          className="w-full sm:w-96"
          value={mixed ? "" : settings.worktreePathTemplate}
          onCommit={(next) => {
            const trimmed = next.trim();
            if (trimmed.length > 0) {
              updateSettings({ worktreePathTemplate: trimmed });
            }
          }}
          placeholder={mixed ? "Mixed" : "{repoRoot}/.worktrees/{branch}"}
          spellCheck={false}
          aria-label="Worktree path template"
        />
      }
    />
  );
}

export function WorktreesSettingsPanel() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection id="worktree-creation" title="Creation">
        {!isProjectScope && <WorktreesDirectoryRow />}
        {!isProjectScope && <WorktreePathTemplateRow />}
        <StartFromRemoteRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title="Branches">
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
