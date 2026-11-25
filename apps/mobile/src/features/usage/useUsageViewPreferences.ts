import { useAtomValue } from "@effect/atom-react";
import type { UsageViewPreferences } from "@t3tools/client-runtime/usage-view";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_VIEW: UsageViewPreferences = {};

export function useUsageViewPreferences() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  return {
    view: AsyncResult.isSuccess(preferences) ? (preferences.value.usageView ?? NO_VIEW) : NO_VIEW,
    update: (patch: UsageViewPreferences) => {
      void savePreferences({
        transform: (current) => ({ usageView: { ...current.usageView, ...patch } }),
      });
    },
  };
}
