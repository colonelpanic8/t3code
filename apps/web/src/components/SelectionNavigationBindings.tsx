import { useLayoutEffect } from "react";

import { handleSelectionNavigationKeyDown } from "../selectionNavigation";

export function SelectionNavigationBindings() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs the global picker keydown listener while mounted
  useLayoutEffect(() => {
    window.addEventListener("keydown", handleSelectionNavigationKeyDown, true);
    return () => window.removeEventListener("keydown", handleSelectionNavigationKeyDown, true);
  }, []);

  return null;
}
