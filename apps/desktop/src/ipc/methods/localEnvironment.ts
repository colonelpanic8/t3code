import { DesktopBackendModeStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBackendMode from "../../app/DesktopBackendMode.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

// Reports whether this launch runs a local backend, which can differ from the
// saved setting (see getBackendModeState).
export const getLocalEnvironmentEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.localEnvironment.getEnabled")(function* () {
    const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
    return yield* backendMode.localEnvironmentEnabled;
  }),
});

export const getBackendModeState = makeSyncIpcMethod({
  channel: IpcChannels.GET_BACKEND_MODE_STATE_CHANNEL,
  result: DesktopBackendModeStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.getBackendModeState")(function* () {
    const backendMode = yield* DesktopBackendMode.DesktopBackendMode;
    return yield* backendMode.get;
  }),
});

export const setLocalEnvironmentEnabled = makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localEnvironment.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const change = yield* appSettings.setLocalEnvironmentEnabled(enabled);
    if (change.changed) {
      yield* lifecycle.relaunch(`localEnvironmentEnabled=${enabled}`);
    }
  }),
});
