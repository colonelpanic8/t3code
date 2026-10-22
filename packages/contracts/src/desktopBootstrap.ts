import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

// Split-layout roots the desktop selected. A legacy-layout desktop sends t3Home instead.
export const DesktopBackendStorageRoots = Schema.Struct({
  layout: Schema.Literal("split"),
  configDir: Schema.String,
  dataDir: Schema.String,
  stateDir: Schema.String,
  cacheDir: Schema.String,
  runtimeDir: Schema.String,
});
export type DesktopBackendStorageRoots = typeof DesktopBackendStorageRoots.Type;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omit in WSL to use the Linux home instead of the mapped Windows directory.
  t3Home: Schema.optional(Schema.String),
  storageRoots: Schema.optional(DesktopBackendStorageRoots),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Derives rotating tokens instead of trusting desktopBootstrapToken indefinitely; see @t3tools/shared/desktopBootstrapToken.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Absent means the backend must hydrate PATH, as WSL and older desktops require.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<t3Home>/runtime` before update shutdown so the backend retains its managed tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
