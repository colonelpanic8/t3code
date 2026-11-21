import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { decideDesktopBackendMode } from "./DesktopApp.ts";
import * as DesktopBackendMode from "./DesktopBackendMode.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopRunningLocalServers from "./DesktopRunningLocalServers.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
describe("desktop backend mode startup", () => {
  it.effect("reports invalid backend-mode launch arguments as fatal startup errors", () =>
    Effect.gen(function* () {
      const quitCount = yield* Ref.make(0);
      const shownErrors = yield* Ref.make<
        readonly {
          title: string;
          content: string;
        }[]
      >([]);
      const layer = Layer.mergeAll(
        DesktopBackendMode.layerTest(["electron", "--backend-mode=invalid"]).pipe(
          Layer.provide(DesktopAppSettings.layerTest()),
        ),
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.mock(DesktopRunningLocalServers.DesktopRunningLocalServers)({}),
        DesktopShutdown.layer,
        DesktopState.layer,
        Layer.mock(ElectronApp.ElectronApp)({
          quit: Ref.update(quitCount, (count) => count + 1),
        }),
        Layer.mock(ElectronDialog.ElectronDialog)({
          showErrorBox: (title, content) =>
            Ref.update(shownErrors, (errors) => [
              ...errors,
              {
                title,
                content,
              },
            ]),
        }),
      );
      yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(decideDesktopBackendMode);
        assert(Exit.isFailure(exit));
        const failure = Cause.findErrorOption(exit.cause);
        assert(Option.isSome(failure));
        assert(
          DesktopBackendMode.isDesktopBackendModeArgumentError(failure.value),
          "expected the original backend mode argument error",
        );
        const errors = yield* Ref.get(shownErrors);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.title, "T3 Code failed to start");
        assert.include(errors[0]?.content ?? "", "Stage: backendMode");
        assert.include(errors[0]?.content ?? "", 'Invalid --backend-mode value "invalid"');
        assert.equal(yield* Ref.get(quitCount), 1);
        const state = yield* DesktopState.DesktopState;
        assert.isTrue(yield* Ref.get(state.quitting));
      }).pipe(Effect.provide(layer));
    }),
  );
});
