import { useIsFocused } from "@react-navigation/native";
import { makeWindow, msUntilNextLocalDay, windowForToday } from "@t3tools/shared/usageFormat";
import { useEffect, useState } from "react";

import { subscribeAppActive } from "../../lib/appState";

/** A timer that fires a hair before midnight re-arms itself; the slack keeps that rare. */
const DAY_ROLLOVER_SLACK_MS = 1000;

export function useUsageWindow() {
  const [selection, setSelection] = useState(() => ({ days: 30, window: makeWindow(30) }));
  const isFocused = useIsFocused();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the window to the new day with the wall clock, screen focus, and app foreground.
  useEffect(() => {
    if (!isFocused) return;
    let timer: ReturnType<typeof setTimeout>;
    const reanchor = () =>
      setSelection((current) => {
        const today = windowForToday(current.window, current.days);
        return today === current.window ? current : { days: current.days, window: today };
      });
    const arm = () => {
      timer = setTimeout(() => {
        reanchor();
        arm();
      }, msUntilNextLocalDay() + DAY_ROLLOVER_SLACK_MS);
    };
    reanchor();
    arm();
    const unsubscribe = subscribeAppActive(reanchor);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [isFocused]);
  return [selection, setSelection] as const;
}
