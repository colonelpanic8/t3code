import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export interface MainWindowState {
  readonly bounds: DesktopAppSettings.DesktopWindowBounds | null;
  readonly maximized: boolean;
}

const DEFAULT_MAIN_WINDOW_STATE: MainWindowState = { bounds: null, maximized: false };

const MainWindowStateDocument = Schema.Struct({
  mainWindowBounds: Schema.optionalKey(Schema.Unknown),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
});
const MainWindowStateJson = fromLenientJson(MainWindowStateDocument);
const decodeMainWindowStateJson = Schema.decodeEffect(MainWindowStateJson);
const encodeMainWindowStateJson = Schema.encodeEffect(MainWindowStateJson);
const windowBoundsEquivalence = Schema.toEquivalence(DesktopAppSettings.DesktopWindowBoundsSchema);

function normalizeMainWindowState(document: typeof MainWindowStateDocument.Type): MainWindowState {
  const bounds = DesktopAppSettings.normalizeMainWindowBounds(document.mainWindowBounds);
  return { bounds, maximized: bounds !== null && document.mainWindowMaximized === true };
}

export class DesktopWindowStateWriteError extends Schema.TaggedError<DesktopWindowStateWriteError>()(
  "DesktopWindowStateWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop window state write failed at ${this.path}.`;
  }
}

export class DesktopWindowState extends Context.Service<
  DesktopWindowState,
  {
    readonly load: Effect.Effect<MainWindowState>;
    readonly get: Effect.Effect<MainWindowState>;
    readonly setMainWindowBounds: (
      bounds: DesktopAppSettings.DesktopWindowBounds,
      isMaximized: boolean,
    ) => Effect.Effect<void, DesktopWindowStateWriteError>;
  }
>()("@t3tools/desktop/window/DesktopWindowState") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = environment.desktopWindowStatePath;
  // None until desktop-window-state.json exists. Until then the bounds older
  // builds stored in desktop-settings.json are used; that file is never
  // written for window state.
  const stateRef = yield* SynchronizedRef.make(Option.none<MainWindowState>());

  const resolve = (state: Option.Option<MainWindowState>) =>
    Option.match(state, {
      onSome: Effect.succeed,
      onNone: () =>
        desktopSettings.get.pipe(
          Effect.map((settings): MainWindowState => ({
            bounds: settings.mainWindowBounds,
            maximized: settings.mainWindowMaximized,
          })),
        ),
    });

  const write = (state: MainWindowState) =>
    encodeMainWindowStateJson({
      ...(state.bounds === null ? {} : { mainWindowBounds: state.bounds }),
      mainWindowMaximized: state.maximized,
    }).pipe(
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({ filePath: statePath, contents: `${encoded}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new DesktopWindowStateWriteError({ path: statePath, cause })),
    );

  return DesktopWindowState.of({
    load: fileSystem.readFileString(statePath).pipe(
      Effect.option,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (raw) =>
            decodeMainWindowStateJson(raw).pipe(
              Effect.map(normalizeMainWindowState),
              Effect.orElseSucceed(() => DEFAULT_MAIN_WINDOW_STATE),
              Effect.asSome,
            ),
        }),
      ),
      Effect.flatMap((state) => SynchronizedRef.setAndGet(stateRef, state)),
      Effect.flatMap(resolve),
      Effect.withSpan("desktop.windowState.load"),
    ),
    get: SynchronizedRef.get(stateRef).pipe(Effect.flatMap(resolve)),
    setMainWindowBounds: (bounds, isMaximized) =>
      SynchronizedRef.modifyEffect(stateRef, (stored) =>
        resolve(stored).pipe(
          Effect.flatMap((current) => {
            if (
              current.bounds !== null &&
              windowBoundsEquivalence(current.bounds, bounds) &&
              current.maximized === isMaximized
            ) {
              return Effect.succeed([undefined, stored] as const);
            }
            const next: MainWindowState = { bounds, maximized: isMaximized };
            return write(next).pipe(Effect.as([undefined, Option.some(next)] as const));
          }),
        ),
      ).pipe(
        Effect.withSpan("desktop.windowState.setMainWindowBounds", {
          attributes: { ...bounds, isMaximized },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopWindowState, make);
