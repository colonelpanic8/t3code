const ENVIRONMENT_SETTINGS_PATHS = new Set([
  "/settings/environment",
  "/settings/providers",
  "/settings/source-control",
  "/settings/diagnostics",
]);

export function isEnvironmentSettingsPath(pathname: string): boolean {
  return ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}
