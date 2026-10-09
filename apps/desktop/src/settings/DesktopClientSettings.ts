import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const decodeClientSettingsDocument = Schema.decodeEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeClientSettingsValue = Schema.decodeUnknownEffect(ClientSettingsSchema);
const decodeClientSettingsJson = Effect.fnUntraced(function* (raw: string) {
  const document = yield* decodeClientSettingsDocument(raw);
  // Select the shape before validation so invalid legacy settings cannot become defaults.
  return yield* decodeClientSettingsValue(
    Object.hasOwn(document, "settings") ? document.settings : document,
  );
});
const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);
const decodeManagedClientSettingsJson = Schema.decodeEffect(fromLenientJson(ClientSettingsPatch));

export class DesktopClientSettingsReadError extends Schema.TaggedError<DesktopClientSettingsReadError>()(
  "DesktopClientSettingsReadError",
  {
    operation: Schema.Literals(["read-file", "decode-document"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings read failed during ${this.operation} at ${this.path}.`;
  }
}

const DesktopClientSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "resolve-symlink",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);

export class DesktopClientSettingsWriteError extends Schema.TaggedError<DesktopClientSettingsWriteError>()(
  "DesktopClientSettingsWriteError",
  {
    operation: DesktopClientSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError>;
    /** Writes the user's settings; values for managed keys keep what the user had. */
    readonly set: (
      settings: ClientSettings,
    ) => Effect.Effect<void, DesktopClientSettingsWriteError>;
    /** Settings fixed by the managed client settings file; `get` already applies them. */
    readonly getManaged: Effect.Effect<ClientSettingsPatch>;
  }
>()("@t3tools/desktop/settings/DesktopClientSettings") {}

// Read on every call so the file can change under a running app. An unusable
// file leaves the user's settings in charge rather than blocking them.
const readManagedClientSettings = (
  fileSystem: FileSystem.FileSystem,
  managedPath: Option.Option<string>,
): Effect.Effect<ClientSettingsPatch> =>
  Option.match(managedPath, {
    onNone: () => Effect.succeed({}),
    onSome: (path) =>
      fileSystem.readFileString(path).pipe(
        Effect.flatMap(decodeManagedClientSettingsJson),
        Effect.catch((cause) =>
          Effect.logWarning("Ignoring managed client settings.", cause).pipe(
            Effect.annotateLogs({ path }),
            Effect.as({}),
          ),
        ),
      ),
  });

/** Put the user's own values back under every managed key before persisting. */
function withoutManagedValues(
  settings: ClientSettings,
  managed: ClientSettingsPatch,
  user: Option.Option<ClientSettings>,
): ClientSettings {
  const previous = Option.getOrElse(user, () => DEFAULT_CLIENT_SETTINGS);
  const restored: Record<string, unknown> = { ...settings };
  for (const key of Object.keys(managed) as Array<keyof ClientSettings>) {
    restored[key] = previous[key];
  }
  return restored as ClientSettings;
}

const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Could not read desktop client settings.", cause).pipe(
              Effect.annotateLogs({ settingsPath }),
              Effect.andThen(
                Effect.fail(
                  new DesktopClientSettingsReadError({
                    operation: "read-file",
                    path: settingsPath,
                    cause,
                  }),
                ),
              ),
            ),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientSettings>()),
        onSome: (raw) =>
          decodeClientSettingsJson(raw).pipe(
            Effect.asSome,
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.logWarning("Could not decode desktop client settings.", cause).pipe(
                  Effect.annotateLogs({ settingsPath }),
                  Effect.andThen(
                    Effect.fail(
                      new DesktopClientSettingsReadError({
                        operation: "decode-document",
                        path: settingsPath,
                        cause,
                      }),
                    ),
                  ),
                ),
            }),
          ),
      }),
    ),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: ClientSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopClientSettingsWriteError> {
  const targetPath = yield* resolveSymlinkTarget(input.settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "resolve-symlink",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  const directory = input.path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeClientSettingsJson(input.settings).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const getManaged = readManagedClientSettings(fileSystem, environment.managedClientSettingsPath);
  const readUserSettings = readClientSettings(fileSystem, environment.clientSettingsPath);
  const writeUserSettings = (settings: ClientSettings) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => uuid.replace(/-/g, "")),
      Effect.mapError(
        (cause) =>
          new DesktopClientSettingsWriteError({
            operation: "create-temporary-file-name",
            path: environment.clientSettingsPath,
            cause,
          }),
      ),
      Effect.flatMap((suffix) =>
        writeClientSettings({
          fileSystem,
          path,
          settingsPath: environment.clientSettingsPath,
          settings,
          suffix,
        }),
      ),
    );

  return DesktopClientSettings.of({
    get: Effect.gen(function* () {
      const user = yield* readUserSettings;
      const managed = yield* getManaged;
      if (Object.keys(managed).length === 0) return user;
      return Option.some({ ...Option.getOrElse(user, () => DEFAULT_CLIENT_SETTINGS), ...managed });
    }).pipe(Effect.withSpan("desktop.clientSettings.get")),
    getManaged,
    set: (requested) =>
      Effect.gen(function* () {
        const managed = yield* getManaged;
        if (Object.keys(managed).length === 0) return requested;
        const user = yield* readUserSettings.pipe(Effect.orElseSucceed(() => Option.none()));
        return withoutManagedValues(requested, managed, user);
      }).pipe(Effect.flatMap(writeUserSettings), Effect.withSpan("desktop.clientSettings.set")),
  });
});

export const layer = Layer.effect(DesktopClientSettings, make);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        set: (settings) => Ref.set(settingsRef, Option.some(settings)),
        getManaged: Effect.succeed({}),
      });
    }),
  );
