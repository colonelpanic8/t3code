import { type MouseEvent, useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";

/**
 * Returns a click handler that opens a URL in the system browser.
 *
 * A bare anchor cannot be used: in the desktop shell it would navigate the app
 * window itself out of the app, and there is no way back. Propagation is
 * stopped so a link inside a row does not also activate the row.
 */
export function useOpenExternalUrl() {
  return useCallback((event: MouseEvent<HTMLElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }

    void api.shell.openExternal(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({
        type: "error",
        title: "Unable to open link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);
}
