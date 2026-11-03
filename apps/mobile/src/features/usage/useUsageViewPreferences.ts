import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { UsageViewPreferences } from "@t3tools/client-runtime/usage-view";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const NO_VIEW: UsageViewPreferences = {};

export function useUsageViewPreferences() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return {
    view: AsyncResult.isSuccess(preferences) ? (preferences.value.usageView ?? NO_VIEW) : NO_VIEW,
    update: (patch: UsageViewPreferences) =>
      savePreferences({
        transform: (current) => ({ usageView: { ...current.usageView, ...patch } }),
      }),
  };
}
