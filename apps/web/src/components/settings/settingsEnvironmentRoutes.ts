const ENVIRONMENT_SETTINGS_PATHS = new Set([
  "/settings/environment",
  "/settings/keybindings",
  "/settings/providers",
  "/settings/source-control",
  "/settings/diagnostics",
]);

export function isEnvironmentSettingsPath(pathname: string): boolean {
  return ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}
