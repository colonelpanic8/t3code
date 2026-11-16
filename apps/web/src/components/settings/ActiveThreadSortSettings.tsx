import { SidebarActiveSortKey, type SidebarActiveSortCriterion } from "@t3tools/contracts/settings";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SORT_KEYS: Record<
  SidebarActiveSortKey,
  { readonly label: string; readonly forward: string; readonly reversed: string }
> = {
  needs_input: { label: "Needs your input", forward: "First", reversed: "Last" },
  working: { label: "Working", forward: "First", reversed: "Last" },
  unread: { label: "Unread result", forward: "First", reversed: "Last" },
  last_user_message: {
    label: "Your last message",
    forward: "Newest first",
    reversed: "Oldest first",
  },
  last_activity: { label: "Last activity", forward: "Newest first", reversed: "Oldest first" },
  created: { label: "Created", forward: "Newest first", reversed: "Oldest first" },
  manual: { label: "Manual arrangement", forward: "As arranged", reversed: "Reversed" },
};

export function ActiveThreadSortRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const criteria = settings.sidebarActiveThreadSort;
  const save = (sidebarActiveThreadSort: ReadonlyArray<SidebarActiveSortCriterion>) =>
    updateSettings({ sidebarActiveThreadSort });
  const move = (index: number, offset: -1 | 1) => {
    const next = [...criteria];
    const [moved] = next.splice(index, 1);
    next.splice(index + offset, 0, moved!);
    save(next);
  };
  const unused = SidebarActiveSortKey.literals.filter(
    (key) => !criteria.some((criterion) => criterion.key === key),
  );

  return (
    <SettingsRow
      {...searchableSetting("active-thread-order")}
      description="How the Active list is ordered. Each criterion only orders threads the ones above it consider equal. With none, the list keeps its built-in order. Dragging within Active works only while Manual arrangement is first."
      resetAction={
        criteria.length === 0 ? null : (
          <SettingResetButton label="active thread order" onClick={() => save([])} />
        )
      }
    >
      <div className="flex flex-col gap-1.5 pt-3 pb-2">
        {criteria.map((criterion, index) => {
          const labels = SORT_KEYS[criterion.key];
          return (
            <div
              key={criterion.key}
              role="group"
              aria-label={`Sort criterion ${index + 1}: ${labels.label}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
              <span className="min-w-36 text-sm">{labels.label}</span>
              <Select
                value={criterion.reverse ? "reversed" : "forward"}
                onValueChange={(value) =>
                  save(
                    criteria.map((candidate, at) =>
                      at === index ? { ...candidate, reverse: value === "reversed" } : candidate,
                    ),
                  )
                }
              >
                <SelectTrigger size="sm" className="w-36" aria-label={`${labels.label} direction`}>
                  <SelectValue>{criterion.reverse ? labels.reversed : labels.forward}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="forward">
                    {labels.forward}
                  </SelectItem>
                  <SelectItem hideIndicator value="reversed">
                    {labels.reversed}
                  </SelectItem>
                </SelectPopup>
              </Select>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label={`Move ${labels.label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label={`Move ${labels.label} down`}
                  disabled={index === criteria.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label={`Remove ${labels.label}`}
                  onClick={() => save(criteria.filter((_, at) => at !== index))}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          );
        })}
        {unused.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {unused.map((key) => (
              <Button
                key={key}
                variant="ghost-muted"
                size="compact"
                onClick={() => save([...criteria, { key, reverse: false }])}
              >
                <PlusIcon />
                {SORT_KEYS[key].label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}
