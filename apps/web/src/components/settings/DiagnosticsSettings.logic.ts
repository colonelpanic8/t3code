import type { EnvironmentId } from "@t3tools/contracts";

export function resolveDiagnosticsEnvironmentId(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly availableEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  const availableEnvironmentIds = new Set(input.availableEnvironmentIds);

  if (
    input.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(input.selectedEnvironmentId)
  ) {
    return input.selectedEnvironmentId;
  }
  if (
    input.primaryEnvironmentId !== null &&
    availableEnvironmentIds.has(input.primaryEnvironmentId)
  ) {
    return input.primaryEnvironmentId;
  }
  if (
    input.activeEnvironmentId !== null &&
    availableEnvironmentIds.has(input.activeEnvironmentId)
  ) {
    return input.activeEnvironmentId;
  }
  return input.availableEnvironmentIds[0] ?? null;
}
