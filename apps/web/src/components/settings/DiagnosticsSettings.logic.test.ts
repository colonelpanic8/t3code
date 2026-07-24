import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { resolveDiagnosticsEnvironmentId } from "./DiagnosticsSettings.logic";

const PRIMARY = EnvironmentId.make("primary");
const ACTIVE = EnvironmentId.make("active");
const SELECTED = EnvironmentId.make("selected");

describe("resolveDiagnosticsEnvironmentId", () => {
  it("preserves an explicit available selection", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [PRIMARY, ACTIVE, SELECTED],
      }),
      SELECTED,
    );
  });

  it("defaults to the primary environment when one is available", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [ACTIVE, PRIMARY],
      }),
      PRIMARY,
    );
  });

  it("uses the active environment when there is no primary environment", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [SELECTED, ACTIVE],
      }),
      ACTIVE,
    );
  });

  it("falls back to the first available environment", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
        availableEnvironmentIds: [SELECTED, ACTIVE],
      }),
      SELECTED,
    );
  });

  it("recovers when the explicit selection is no longer available", () => {
    assert.equal(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [PRIMARY, ACTIVE],
      }),
      PRIMARY,
    );
  });

  it("returns null when no environments are available", () => {
    assert.isNull(
      resolveDiagnosticsEnvironmentId({
        selectedEnvironmentId: SELECTED,
        primaryEnvironmentId: PRIMARY,
        activeEnvironmentId: ACTIVE,
        availableEnvironmentIds: [],
      }),
    );
  });
});
