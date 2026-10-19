import { useEffect } from "react";

import { evaExtension } from "../../native/eva-extension";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { buildAssistantCatalog } from "./assistant-catalog";
import { assistantCatalogEnvironments } from "./assistant-runtime";

const PUBLISH_DEBOUNCE_MS = 1500;

function catalogJson(): string {
  return JSON.stringify(
    buildAssistantCatalog({
      now: new Date(),
      environments: assistantCatalogEnvironments(),
      projects: appAtomRegistry.get(environmentProjects.projectsAtom),
      threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    }),
  );
}

/**
 * Publishes the bounded environment/project/thread catalog the assistant
 * content provider serves, so an assistant can list and pick targets without
 * waking React Native. Debounced: thread shells change on every run update,
 * the catalog only when names, statuses, or membership do.
 */
export function AssistantCatalogSync() {
  useEffect(() => {
    const native = evaExtension;
    if (!native) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPublished: string | null = null;
    const publish = () => {
      timer = null;
      const json = catalogJson();
      // The capture time alone is not a change worth a write.
      const content = json.replace(/"capturedAt":"[^"]*"/, "");
      if (content === lastPublished) return;
      lastPublished = content;
      try {
        native.publishAssistantCatalog(json);
      } catch (error) {
        console.warn("[eva] Could not publish the assistant catalog", error);
      }
    };
    const schedule = () => {
      if (timer === null) timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS);
    };
    const unsubscribes = [
      appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, schedule),
      appAtomRegistry.subscribe(environmentProjects.projectsAtom, schedule),
      appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, schedule),
    ];
    schedule();
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, []);
  return null;
}
