import { AppRegistry } from "react-native";

import { ASSISTANT_TASK_KEY, runAssistantTask } from "./assistant-task";

/** Must run at bundle load: a headless start mounts no component that could register it. */
export function registerAssistantTask(): void {
  AppRegistry.registerHeadlessTask(ASSISTANT_TASK_KEY, () => runAssistantTask);
}
