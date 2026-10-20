import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { sourceControlHostSecretName } from "./sourceControl/sourceControlHostSecrets.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

/** Settings over an existing home whose managed settings file sits next to settings.json. */
const layerServerSettingsWithManagedFile = (baseDir: string) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, managedSettingsPath: `${config.stateDir}/managed-settings.json` };
        }),
      ).pipe(Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir)))),
    ),
  );

const layerFailingSecretStore = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("serializes concurrent model preference edits without cancelling duplicate adds", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const provider = ProviderInstanceId.make("codex_work");
      yield* Effect.all(
        [
          service.updateSettings({
            setModelFavorites: [{ provider, model: "sol", favorite: true }],
          }),
          service.updateSettings({
            setModelFavorites: [{ provider, model: "sol", favorite: true }],
          }),
          service.updateSettings({
            setModelFavorites: [{ provider, model: "luna", favorite: true }],
          }),
          service.updateSettings({ setModelsHidden: [{ provider, model: "astra", hidden: true }] }),
          service.updateSettings({ setModelsHidden: [{ provider, model: "luna", hidden: true }] }),
          service.updateSettings({
            setProviderModelOrder: { provider, modelOrder: ["luna", "sol"] },
          }),
        ],
        { concurrency: "unbounded" },
      );
      const settings = yield* service.getSettings;
      assert.deepEqual(settings.favorites?.map((entry) => entry.model).sort(), ["luna", "sol"]);
      assert.deepEqual(settings.providerModelPreferences?.[provider]?.hiddenModels.toSorted(), [
        "astra",
        "luna",
      ]);
      assert.deepEqual(settings.providerModelPreferences?.[provider]?.modelOrder, ["luna", "sol"]);
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("persists and broadcasts model preferences to other connected clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const provider = ProviderInstanceId.make("codex_work");
        const patch = {
          favorites: [{ provider, model: "sol" }],
          providerModelPreferences: {
            [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] },
          },
        };
        const changes = yield* service.subscribeChanges;
        yield* service.updateSettings(patch);
        const received = Option.getOrThrow(yield* Stream.runHead(changes));
        assert.deepEqual(received.favorites, patch.favorites);
        assert.deepEqual(received.providerModelPreferences, patch.providerModelPreferences);
        const saved = yield* decodeServerSettingsJson(
          yield* fs.readFileString(config.settingsPath),
        );
        assert.deepEqual(saved.favorites, patch.favorites);
        assert.deepEqual(saved.providerModelPreferences, patch.providerModelPreferences);
        const hidden = yield* service.updateSettings({
          setModelsHidden: [{ provider, model: "sol", hidden: true }],
        });
        assert.deepEqual(hidden.providerModelPreferences?.[provider], {
          hiddenModels: ["astra", "sol"],
          modelOrder: ["sol"],
        });
        const shown = yield* service.updateSettings({
          setModelsHidden: [{ provider, model: "astra", hidden: false }],
        });
        assert.deepEqual(shown.providerModelPreferences?.[provider], {
          hiddenModels: ["sol"],
          modelOrder: ["sol"],
        });
        assert.deepEqual(
          (yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath)))
            .providerModelPreferences,
          shown.providerModelPreferences,
        );
        yield* service.updateSettings({ favorites: [], providerModelPreferences: {} });

        const migrated = yield* service.updateSettings({ migrateModelPreferences: patch });
        assert.deepEqual(migrated.favorites, []);
        assert.deepEqual(migrated.providerModelPreferences, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("migrates saved token delivery to paragraph buffering without resetting settings", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        `{
          "responseStreamingMode": "token",
          "enableAgentBrowserAccess": false,
          "projectSettingsOverrides": {
            "legacy": { "responseStreamingMode": "token", "defaultAutoPull": true },
            "buffered": { "responseStreamingMode": "turn" },
            "inherited": { "defaultAutoPull": false }
          }
        }`,
      );

      const settings = yield* service.getSettings;
      assert.equal(settings.responseStreamingMode, "paragraph");
      assert.isFalse(settings.enableAgentBrowserAccess);
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("legacy")]: { responseStreamingMode: "paragraph", defaultAutoPull: true },
        [ProjectId.make("buffered")]: { responseStreamingMode: "turn" },
        [ProjectId.make("inherited")]: { defaultAutoPull: false },
      });

      yield* service.updateSettings({ responseStreamingMode: "turn" });
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "turn");
      assert.deepEqual(persisted.projectSettingsOverrides, settings.projectSettingsOverrides);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("saves through a symlinked settings file without replacing the link", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
      yield* fs.remove(config.settingsPath, { force: true });
      yield* fs.symlink(linkedSettingsPath, config.settingsPath);

      yield* service.updateSettings({ responseStreamingMode: "paragraph" });

      assert.equal(yield* fs.readLink(config.settingsPath), linkedSettingsPath);
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(linkedSettingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "paragraph");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("reloads when the destination of a symlinked settings file changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "settings.json");
        yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("follows a settings link that is repointed to another directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const firstSettingsPath = path.join(dotfiles, "first", "settings.json");
        const secondSettingsPath = path.join(dotfiles, "second", "settings.json");
        yield* fs.makeDirectory(path.dirname(firstSettingsPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(secondSettingsPath), { recursive: true });
        yield* fs.writeFileString(firstSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.writeFileString(secondSettingsPath, `{ "responseStreamingMode": "paragraph" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(firstSettingsPath, config.settingsPath);
        yield* service.start;

        const repointChanges = yield* service.subscribeChanges;
        yield* fs.remove(config.settingsPath);
        yield* fs.symlink(secondSettingsPath, config.settingsPath);
        const repointed = yield* repointChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(repointed)?.responseStreamingMode, "paragraph");

        const editChanges = yield* service.subscribeChanges;
        yield* writeFileStringAtomically({
          filePath: secondSettingsPath,
          contents: `{ "responseStreamingMode": "turn" }`,
        });
        const edited = yield* editChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(edited)?.responseStreamingMode, "turn");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("reloads when a dangling settings link gets its destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "not-yet", "settings.json");
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerServerSettings())),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const layerConfig = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(layerConfig),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* fileSystem.makeDirectory(serverConfig.settingsPath);

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, { _tag: "ServerSettingsError", operation: "read-file" });

      yield* fileSystem.remove(serverConfig.settingsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "responseStreamingMode": "turn" }`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.equal(settings.responseStreamingMode, "turn");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        observability: { otlpMetricsUrl: "http://localhost:4318/v1/metrics" },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.equal(next.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
      assert.equal(next.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps an external settings edit that the watcher has not reloaded yet", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.getSettings;

      yield* writeFileStringAtomically({
        filePath: config.settingsPath,
        contents: `{ "responseStreamingMode": "turn" }`,
      });
      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
      });

      const saved = yield* decodeServerSettingsJson(yield* fs.readFileString(config.settingsPath));
      assert.equal(saved.responseStreamingMode, "turn");
      assert.equal(saved.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");

      yield* writeFileStringAtomically({
        filePath: config.settingsPath,
        contents: `{ "responseStreamingMode": "paragraph" }`,
      });
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Kilo",
          config: { agentId: "kilo", distribution: "auto" },
        },
      });

      const afterProviderSave = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(afterProviderSave.responseStreamingMode, "paragraph");
      assert.equal(afterProviderSave.providerInstances[instanceId]?.displayName, "Kilo");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("refuses to save over a settings file it cannot parse", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.getSettings;
      const raw = `{ "responseStreamingMode": "turn", `;
      yield* fs.writeFileString(config.settingsPath, raw);

      const error = yield* Effect.flip(
        serverSettings.updateSettings({
          observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        }),
      );

      if (error._tag !== "ServerSettingsError") throw error;
      assert.equal(error.operation, "read-file");
      assert.equal(error.settingsPath, config.settingsPath);
      assert.instanceOf(error.cause, Error);
      assert.equal(yield* fs.readFileString(config.settingsPath), raw);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("creates provider instances atomically without overwriting a concurrent add", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("acpRegistry_shared");
      const results = yield* Effect.all(
        ["First", "Second"].map((displayName) =>
          serverSettings
            .updateProviderInstance({
              operation: "create",
              instanceId,
              instance: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName,
                config: { agentId: "shared", distribution: "auto" },
              },
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.isTrue(
        ["First", "Second"].includes(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName ?? "",
        ),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("pauses provider-instance mutations while a settings snapshot is in use", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const snapshotEntered = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const mutationCompleted = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");

      const snapshotFiber = yield* serverSettings
        .withSettingsSnapshot(() =>
          Deferred.succeed(snapshotEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSnapshot)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(snapshotEntered);

      const mutationFiber = yield* serverSettings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Kilo",
            config: { agentId: "kilo", distribution: "auto" },
          },
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(mutationCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;

      assert.isTrue(Option.isNone(yield* Deferred.poll(mutationCompleted)));
      yield* Deferred.succeed(releaseSnapshot, undefined);
      yield* Fiber.join(snapshotFiber);
      yield* Fiber.join(mutationFiber);
      assert.equal(
        (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName,
        "Kilo",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          addProjectBaseDirectory: "~/next",
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(Option.getOrUndefined(firstChange)?.addProjectBaseDirectory, "~/next");
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves saved usage settings during cleanup edits and removes custom prices", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const usageModelAliases = { "example-preview": "example-model" };
        const sourceId = UsageLimitSourceId.make("hub");
        const usageLimitSources = {
          [sourceId]: {
            kind: "cliproxy" as const,
            url: "https://hub.example.test",
            managementKey: "",
            enabled: true,
          },
        };
        const saved = yield* serverSettings.updateSettings({
          usageModelAliases,
          usageLimitSources,
        });
        const updated = yield* serverSettings.updateSettings({
          storageCleanup: { worktreeSettledAfterDays: 0, worktreeKeepWhen: "any-local-files" },
        });
        assert.deepStrictEqual(updated.usageLimitSources, saved.usageLimitSources);
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });
        assert.deepStrictEqual(persisted.usageModelAliases, usageModelAliases);
        assert.deepStrictEqual(persisted.usageLimitSources, usageLimitSources);
        assert.equal(persisted.storageCleanup.worktreeSettledAfterDays, 0);
        assert.equal(persisted.storageCleanup.worktreeKeepWhen, "any-local-files");

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("persists and broadcasts thread settlement settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        const next = yield* serverSettings.updateSettings({
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
        });
        const change = Option.getOrUndefined(yield* Stream.runHead(changes));
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);

        const persisted = JSON.parse(raw) as Record<string, unknown>;

        assert.strictEqual(next.sidebarAutoSettleAfterDays, null);
        assert.isFalse(next.sidebarAutoSettleOnMerge);
        assert.strictEqual(change?.sidebarAutoSettleAfterDays, null);
        assert.isFalse(change?.sidebarAutoSettleOnMerge);
        assert.strictEqual(persisted.sidebarAutoSettleAfterDays, null);
        assert.isFalse(persisted.sidebarAutoSettleOnMerge);
      }),
    ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "keeps a custom instance's selection when the driver's default instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect.each(["codex"])(
    "falls back to enabled instance %s after disabling the selection",
    (fallbackId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const writerId = ProviderInstanceId.make("writer");
          const fallbackInstanceId = ProviderInstanceId.make(fallbackId);
          const selection = { instanceId: writerId, model: "claude-sonnet-4-6" };
          const providerInstances = {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [fallbackInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [writerId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
          };

          yield* serverSettings.updateSettings({
            providerInstances,
            textGenerationModelSelection: selection,
          });
          const changes = yield* serverSettings.subscribeChanges;

          const next = yield* serverSettings.updateSettings({
            providerInstances: {
              ...providerInstances,
              [writerId]: { ...providerInstances[writerId]!, enabled: false },
            },
          });
          const fallbackSelection = {
            instanceId: fallbackInstanceId,
            model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          };
          assert.deepEqual(next.textGenerationModelSelection, fallbackSelection);
          assert.deepEqual(
            (yield* serverSettings.getSettings).textGenerationModelSelection,
            fallbackSelection,
          );
          const change = Option.getOrUndefined(yield* Stream.runHead(changes));
          assert.deepEqual(change?.textGenerationModelSelection, fallbackSelection);

          const persisted = yield* fileSystem
            .readFileString(serverConfig.settingsPath)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))),
            );
          assert.deepEqual(persisted.textGenerationModelSelection, selection);

          const restored = yield* serverSettings.updateSettings({ providerInstances });
          assert.deepEqual(restored.textGenerationModelSelection, selection);
        }),
      ).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips explicitly disabled default instances when choosing a fallback", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      });

      assert.equal(next.textGenerationModelSelection.instanceId, "claudeAgent");
      assert.equal(next.textGenerationModelSelection.model, "claude-haiku-5-5");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  // A backend behind a custom model may refuse the built-in default (#12651).
  it.effect("falls back to the thread default when it is a custom model on that instance", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const claude = ProviderInstanceId.make("claudeAgent");
      const providerInstances = {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
        [claude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["z-ai/glm-5.3-flash"] },
        },
      };

      const custom = yield* serverSettings.updateSettings({
        providerInstances,
        defaultModelSelection: {
          instanceId: claude,
          model: "z-ai/glm-5.3-flash",
          options: [{ id: "thinking", value: false }],
        },
      });
      assert.deepEqual(custom.textGenerationModelSelection, {
        instanceId: claude,
        model: "z-ai/glm-5.3-flash",
        options: [{ id: "thinking", value: false }],
      });

      const builtIn = yield* serverSettings.updateSettings({
        defaultModelSelection: { instanceId: claude, model: "claude-fable-5-1" },
      });
      assert.equal(builtIn.textGenerationModelSelection.model, "claude-haiku-5-5");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next, undefined, null),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored, undefined, null),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("moves customized legacy provider settings into default instances on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          addProjectBaseDirectory: "~/Development",
          providers: {
            codex: { binaryPath: "/opt/guard/bin/codex" },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            grok: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances, {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: "/opt/guard/bin/codex" },
        },
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: {},
        },
      });

      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.equal(persisted.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(persisted.providerInstances.codex, {
        driver: "codex",
        config: { binaryPath: "/opt/guard/bin/codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps an explicit default instance over the legacy blob for its driver", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { codex: { binaryPath: "/legacy/codex" } },
          providerInstances: {
            codex: { driver: "codex", enabled: true, config: { binaryPath: "/explicit/codex" } },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { binaryPath: "/explicit/codex" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("enables previously used optional providers while migrating legacy settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { opencode: { serverUrl: "http://127.0.0.1:4096" }, cursor: {} },
          providerInstances: {
            cursor_work: { driver: "cursor", config: {} },
            opencode_unused: { driver: "opencode", config: {} },
          },
        }),
      );
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("cursor", "cursor_work");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("opencode")], {
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        config: { serverUrl: "http://127.0.0.1:4096" },
      });

      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);

      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps explicit legacy disables even when provider history shows use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({ providers: { grok: { enabled: false, binaryPath: "/opt/grok" } } }),
      );
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("grok")], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("runs provider history only for files that still carry the legacy map", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances, {});
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("migrates legacy providers from an invalid file without rewriting it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const raw =
        '{"addProjectBaseDirectory":42,"continueThreadsAfterServerUpdate":"false","providers":{"codex":{"binaryPath":"/x"}}}';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/x" },
      });

      assert.isFalse(settings.continueThreadsAfterServerUpdate);
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps a default-off provider's new instance disabled and sparse on disk", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });

      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("writes only non-default settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("saves a writing style whose other fields are defaults", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.updateSettings({
        sourceControlWritingStyle: { mode: "conventional_commits" },
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        sourceControlWritingStyle: { mode: "conventional_commits" },
      });
      assert.deepEqual((yield* serverSettings.getSettings).sourceControlWritingStyle, {
        mode: "conventional_commits",
        customInstructions: "",
        followChangeRequestTemplates: true,
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerSecret),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-inline-secret-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );
      assert.equal(error._tag, "ServerSettingsError");
      if (error._tag !== "ServerSettingsError") return;
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect.each(
    [
      {
        label: "preserves an inline secret on a redacted settings save",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "inline-test-token",
      },
      {
        label: "preserves the effective last inline secret when names are duplicated",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "last-inline-test-token",
        duplicate: true,
      },
      {
        label: "replaces an inline secret with an explicit value",
        variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
        expected: "replacement-test-token",
      },
      {
        label: "clears an inline secret with an explicit empty value",
        variable: { name: "API_TOKEN", value: "", sensitive: true },
        expected: "",
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )("%s", ([, { variable, expected, duplicate }]) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        duplicate
          ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
          : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
      );
      const initial = yield* serverSettings.getSettings;
      assert.equal(
        initial.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Renamed provider",
            environment: duplicate ? [variable, variable] : [variable],
            config: {},
          },
        },
      });
      assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "inline-test-token");
      assert.notInclude(raw, "replacement-test-token");

      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect.each([true, false])(
    "preserves duplicate secret operation order (sensitive last: %s)",
    (sensitiveLast) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_duplicate");
        const secret = { name: "API_TOKEN", value: "secret-last", sensitive: true };
        const plain = { name: "API_TOKEN", value: "plain-last", sensitive: false };
        const next = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: sensitiveLast ? [plain, secret] : [secret, plain],
              config: {},
            },
          },
        });
        assert.equal(
          next.providerInstances[instanceId]?.environment?.at(-1)?.value,
          sensitiveLast ? "secret-last" : "plain-last",
        );
        assert.equal(
          next.providerInstances[instanceId]?.environment?.find((v) => v.sensitive)?.value,
          sensitiveLast ? "secret-last" : "",
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "uses the same secret lifecycle for provider config, environment, host tokens, and quota keys",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const instanceId = ProviderInstanceId.make("antigravity_secrets");
        const saved = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              config: { apiKey: "config-secret" },
              environment: [
                { name: "API_TOKEN", value: "env-secret", sensitive: true },
                { name: "BASE_URL", value: "https://example.test", sensitive: false },
              ],
            },
          },
          sourceControlHosts: {
            github: { tokens: { "github.com": "github-secret" } },
            bitbucket: { email: "me@example.test", accessToken: "bitbucket-secret" },
            gitcafe: { token: "gitcafe-secret" },
          },
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.example.test",
              managementKey: "quota-secret",
              enabled: true,
            },
          },
          easDeviceHosts: [
            {
              kind: "eas",
              id: "eas",
              label: "EAS Simulator",
              accessToken: "expo-secret",
              maxSessionMinutes: 30,
              idleMinutes: 10,
              maxConcurrentSessions: 2,
            },
          ],
        });
        const values = [
          "config-secret",
          "env-secret",
          "github-secret",
          "bitbucket-secret",
          "gitcafe-secret",
          "quota-secret",
          "expo-secret",
        ];
        const client = ServerSettingsModule.redactServerSettingsForClient(saved);
        const disk = yield* fs.readFileString(config.settingsPath);
        for (const value of values) {
          assert.include(JSON.stringify(saved), value);
          assert.notInclude(JSON.stringify(client), value);
          assert.notInclude(disk, value);
        }
        assert.include(JSON.stringify(client), "https://example.test");
        assert.include(JSON.stringify(client), "me@example.test");
        const echoed = yield* service.updateSettings({
          providerInstances: client.providerInstances,
          sourceControlHosts: client.sourceControlHosts,
          usageLimitSources: client.usageLimitSources,
          easDeviceHosts: client.easDeviceHosts,
        });
        for (const value of values) assert.include(JSON.stringify(echoed), value);
        const renamed = yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: { ...client.providerInstances[instanceId]!, displayName: "Renamed" },
        });
        assert.propertyVal(
          renamed.providerInstances[instanceId]?.config,
          "apiKey",
          "config-secret",
        );

        for (const apiKey of ["replacement-secret", ""]) {
          const changed = yield* service.updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: { ...client.providerInstances[instanceId]!, config: { apiKey } },
          });
          assert.propertyVal(changed.providerInstances[instanceId]?.config, "apiKey", apiKey);
          const redacted = ServerSettingsModule.redactServerSettingsForClient(changed);
          assert.propertyVal(
            redacted.providerInstances[instanceId]?.config,
            "apiKey",
            apiKey ? "••••••" : "",
          );
        }

        yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: saved.providerInstances[instanceId]!,
        });

        const secretNames = [
          "provider-config-YW50aWdyYXZpdHlfc2VjcmV0cw-YW50aWdyYXZpdHk-YXBpS2V5",
          "provider-env-YW50aWdyYXZpdHlfc2VjcmV0cw-QVBJX1RPS0VO",
          sourceControlHostSecretName({
            kind: "github",
            field: "tokens",
            serverHost: "github.com",
          }),
          sourceControlHostSecretName({
            kind: "bitbucket",
            field: "accessToken",
            serverHost: null,
          }),
          sourceControlHostSecretName({ kind: "gitcafe", field: "token", serverHost: null }),
          "usage-limit-source-aHVi",
        ];
        for (const name of secretNames) {
          assert.isTrue(Option.isSome(yield* store.get(name)), name);
        }
        yield* service.updateSettings({
          providerInstances: {},
          sourceControlHosts: {
            github: { tokens: {} },
            bitbucket: { accessToken: "" },
            gitcafe: { token: "" },
          },
          usageLimitSources: { [UsageLimitSourceId.make("hub")]: null },
        });
        for (const name of secretNames) {
          assert.isTrue(Option.isNone(yield* store.get(name)));
        }
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("moves saved provider credentials to the secret store when settings load", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providerInstances: {
            antigravity: { driver: "antigravity", config: { apiKey: "legacy-api-key" } },
            opencode: {
              driver: "opencode",
              config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "legacy-password" },
            },
          },
        }),
      );
      const saved = yield* service.getSettings;
      const opencode = ProviderInstanceId.make("opencode");
      assert.propertyVal(
        saved.providerInstances[ProviderInstanceId.make("antigravity")]?.config,
        "apiKey",
        "legacy-api-key",
      );
      assert.propertyVal(
        saved.providerInstances[opencode]?.config,
        "serverPassword",
        "legacy-password",
      );
      const client = ServerSettingsModule.redactServerSettingsForClient(saved);
      for (const value of ["legacy-api-key", "legacy-password"]) {
        assert.notInclude(yield* fs.readFileString(config.settingsPath), value);
        assert.notInclude(JSON.stringify(client), value);
      }
      // Editing another field from the client's copy keeps the saved password.
      const clientConfig = client.providerInstances[opencode]?.config as Record<string, unknown>;
      const edited = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: opencode,
        instance: {
          ...client.providerInstances[opencode]!,
          config: { ...clientConfig, serverUrl: "http://127.0.0.1:4097" },
        },
      });
      assert.deepInclude(edited.providerInstances[opencode]?.config, {
        serverUrl: "http://127.0.0.1:4097",
        serverPassword: "legacy-password",
      });
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "keeps source control host secrets in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { email: "me@example.com", accessToken: "bb-access" },
            github: { tokens: { "github.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
          },
        });
        assert.deepEqual(saved.sourceControlHosts.bitbucket, {
          email: "me@example.com",
          accessToken: "bb-access",
        });
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        for (const secret of ["bb-access", "ghp_dotcom", "ghp_ghe"]) assert.notInclude(raw, secret);
        assert.include(raw, "me@example.com");

        const forClient =
          ServerSettingsModule.redactServerSettingsForClient(saved).sourceControlHosts;
        assert.equal(forClient.bitbucket?.email, "me@example.com");
        assert.notInclude(String(forClient.bitbucket?.accessToken), "bb-access");
        assert.isAbove(String(forClient.bitbucket?.accessToken).length, 0);

        yield* serverSettings.updateSettings({ sourceControlHosts: forClient });
        yield* serverSettings.updateSettings({
          sourceControlHosts: { bitbucket: { email: "other@example.com" } },
        });
        const kept = (yield* serverSettings.getSettings).sourceControlHosts;
        assert.deepEqual(kept.bitbucket, { email: "other@example.com", accessToken: "bb-access" });
        assert.deepEqual(kept.github?.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });

        const cleared = yield* serverSettings.updateSettings({
          sourceControlHosts: {
            bitbucket: { accessToken: "" },
            github: {
              tokens: {
                "github.com": "",
                "ghe.acme.test": (forClient.github!.tokens as Record<string, string>)[
                  "ghe.acme.test"
                ],
              },
            },
          },
        });
        assert.equal(cleared.sourceControlHosts.bitbucket?.accessToken, "");
        const stored = (kind: string, field: string, serverHost: string | null) =>
          secrets.get(sourceControlHostSecretName({ kind, field, serverHost }));
        assert.isTrue(Option.isNone(yield* stored("bitbucket", "accessToken", null)));
        assert.isTrue(Option.isNone(yield* stored("github", "tokens", "github.com")));
        assert.isTrue(Option.isSome(yield* stored("github", "tokens", "ghe.acme.test")));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("keeps the retired keys for another load when a token cannot be copied", () => {
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "bitbucket-access-token",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: "bitbucket-access-token",
        description: "Secret backend unavailable.",
      }),
    });
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-server-settings-legacy-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacy = JSON.stringify({
        bitbucket: { email: "me@example.com", accessToken: "\u2022\u2022\u2022\u2022\u2022\u2022" },
      });
      yield* fileSystem.writeFileString(serverConfig.settingsPath, legacy);

      yield* Effect.exit(serverSettings.getSettings);

      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), legacy);
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("moves the retired bitbucket and github keys and their secrets on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const marker = "\u2022\u2022\u2022\u2022\u2022\u2022";
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("bb-saved"));
      yield* secrets.set(
        `github-token-${Buffer.from("github.com", "utf8").toString("base64url")}`,
        new TextEncoder().encode("ghp_saved"),
      );
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          bitbucket: { email: "me@example.com", accessToken: marker },
          github: {
            hosts: { "github.com": { account: "work" } },
            tokens: { "github.com": marker },
          },
        }),
      );

      const loaded = (yield* serverSettings.getSettings).sourceControlHosts;

      assert.deepEqual(loaded.bitbucket, { email: "me@example.com", accessToken: "bb-saved" });
      assert.deepEqual(loaded.github?.tokens, { "github.com": "ghp_saved" });
      assert.deepEqual(loaded.github?.hosts, { "github.com": { account: "work" } });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, '"bitbucket":{"email"');
      assert.include(raw, "sourceControlHosts");
      assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "moves a hand-edited source control token into the secret store when settings load",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          '{"sourceControlHosts":{"bitbucket":{"accessToken":"hand-edited-token"}}}',
        );

        const loaded = yield* serverSettings.getSettings;

        assert.equal(loaded.sourceControlHosts.bitbucket?.accessToken, "hand-edited-token");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "hand-edited-token",
        );
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("materializes provider secrets for terminal environment resolution", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("codex_terminal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-terminal-secret", sensitive: true },
            ],
            config: { homePath: "~/.codex-terminal" },
          },
        },
      });

      const environment = yield* resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: instanceId,
        env: undefined,
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);

      assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
      assert.match(environment.CODEX_HOME ?? "", /[\\/][.]codex-terminal$/);
      assert.notInclude(persisted, "sk-terminal-secret");
      assert.include(persisted, '"valueRedacted": true');
    }).pipe(Effect.provide(layerServerSettings())),
  );
  it.effect("rolls back provider secret changes when the settings file commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRename = false;
      let settingsPathToFail: string | undefined;
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "Forced settings write failure.",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          failRename && toPath === settingsPathToFail
            ? Effect.fail(writeFailure)
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("antigravity_write_failure");
      const layerSettings = layerServerSettings().pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        settingsPathToFail = (yield* ServerConfig.ServerConfig).settingsPath;
        yield* serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("antigravity"),
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
            config: { apiKey: "config-kept" },
          },
        });

        failRename = true;
        const failedUpdate = yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("antigravity"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
              config: { apiKey: "config-new" },
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
        );

        const failed = yield* serverSettings
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    }),
  );

  it.effect.each(["response materialization", "partially committed write"] as const)(
    "rolls back provider secret changes after %s fails",
    (failure) => {
      const textDecoder = new TextDecoder();
      const secrets = new Map<string, Uint8Array>();
      let rejectNewSecret = false;
      const layerSecretStore = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.suspend(() => {
              const value = secrets.get(name);
              if (
                failure === "response materialization" &&
                rejectNewSecret &&
                value !== undefined &&
                textDecoder.decode(value) === "sk-new"
              ) {
                return Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause: "Forced response materialization failure.",
                  }),
                );
              }
              return Effect.succeed(
                value === undefined ? Option.none() : Option.some(Uint8Array.from(value)),
              );
            }),
          set: (name, value) =>
            Effect.suspend(() => {
              secrets.set(name, Uint8Array.from(value));
              return failure === "partially committed write" &&
                rejectNewSecret &&
                textDecoder.decode(value) === "sk-new"
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: `secret ${name}`,
                      cause: "chmod failed after rename",
                    }),
                  )
                : Effect.void;
            }),
          create: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, Uint8Array.from(value));
            }),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const value = secrets.get(name) ?? new Uint8Array(bytes);
              secrets.set(name, value);
              return Uint8Array.from(value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
      );
      const layerSettings = ServerSettingsModule.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(layerSecretStore),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3code-server-settings-materialization-failure-test-",
            }),
          ),
        ),
      );
      const instanceId = ProviderInstanceId.make("codex_materialization_failure");

      return Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: { apiKey: "config-kept" },
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("antigravity"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: { apiKey: "config-new" },
              },
            },
          })
          .pipe(Effect.result);

        assert.equal(failedUpdate._tag, "Failure");
        rejectNewSecret = false;
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
        assert.propertyVal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.config,
          "apiKey",
          "config-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    },
  );

  it.effect("folds legacy project overrides into projectSettingsOverrides once", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy");
      const scriptedProject = ProjectId.make("project-scripted");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
      const scriptsJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ProjectScript)),
      )([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsFolded);
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [legacyProject]: {
            enableAgentBrowserAccess: false,
            defaultModelSelection: model,
            defaultThreadEnvMode: "worktree",
            defaultAutoPull: true,
          },
          [scriptedProject]: { defaultAutoPull: true, defaultProjectScripts: [script] },
        },
      );

      assert.deepEqual<ServerSettings["projectAutoPullOverrides"]>(
        settings.projectAutoPullOverrides,
        {
          [legacyProject]: true,
          [scriptedProject]: true,
        },
      );
      assert.deepEqual<ServerSettings["projectScriptOverrides"]>(settings.projectScriptOverrides, {
        [scriptedProject]: [script],
      });

      yield* serverSettings.updateSettings({
        projectSettingsOverrides: { [legacyProject]: null },
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(JSON.parse(raw));
      assert.isTrue(persisted.projectSettingsFolded);
      assert.isUndefined(persisted.projectSettingsOverrides[legacyProject]);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("leaves an unreadable settings.json untouched instead of folding over it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${"project-broken"}, ${"Project"}, ${"/tmp/project-broken"}, ${1}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      const broken = '{"defaultAutoPull": tru';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, broken);

      const settings = yield* serverSettings.getSettings;
      assert.isFalse(settings.projectSettingsFolded);
      assert.isFalse(settings.continueThreadsAfterServerUpdate);
      assert.deepEqual(settings.projectSettingsOverrides, {});

      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect(
    "applies managed settings without persisting them, and hands keys back once unmanaged",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-settings-" });
        const settingsPath = `${baseDir}/userdata/settings.json`;
        const managedPath = `${baseDir}/userdata/managed-settings.json`;
        yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fs.writeFileString(settingsPath, '{"branchNamePrefix":"user/"}');
        yield* fs.writeFileString(
          managedPath,
          JSON.stringify({
            branchNamePrefix: "nix/",
            providerInstances: { codex: { driver: "codex", config: { homePath: "/managed" } } },
          }),
        );
        const codex = ProviderInstanceId.make("codex");

        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const settings = yield* service.getSettings;
          assert.equal(settings.branchNamePrefix, "nix/");
          assert.deepEqual(settings.providerInstances[codex]?.config, { homePath: "/managed" });
          assert.deepEqual(yield* service.managedSettingPaths, [
            ["branchNamePrefix"],
            ["providerInstances", "codex"],
          ]);

          const rejected = yield* Effect.flip(
            service.updateSettings({ branchNamePrefix: "other/" }),
          );
          assert.equal(rejected._tag, "ManagedSettingWriteError");
          assert.equal(rejected.message, "branchNamePrefix is managed by system configuration.");

          // Echoing managed values back, as the whole-map provider patch does, is not a change.
          const added = ProviderInstanceId.make("codex_work");
          const updated = yield* service.updateSettings({
            branchNamePrefix: "nix/",
            defaultAutoPull: true,
            providerInstances: {
              ...settings.providerInstances,
              [added]: { driver: ProviderDriverKind.make("codex"), config: {} },
            },
          });
          assert.isTrue(updated.defaultAutoPull);
          assert.equal(updated.branchNamePrefix, "nix/");
          assert.deepEqual(updated.providerInstances[codex]?.config, { homePath: "/managed" });
          assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), {
            branchNamePrefix: "user/",
            defaultAutoPull: true,
            providerInstances: { codex_work: { driver: "codex", config: {} } },
          });
        }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));

        yield* fs.writeFileString(managedPath, "{}");
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const settings = yield* service.getSettings;
          assert.equal(settings.branchNamePrefix, "user/");
          assert.isUndefined(settings.providerInstances[codex]);
          assert.deepEqual(yield* service.managedSettingPaths, []);
        }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
      }),
  );

  it.effect("ignores an invalid managed entry and keeps enforcing the rest of the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-partial-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/settings.json`,
        JSON.stringify({
          providerInstances: { codex: { driver: "codex", config: { homePath: "/local" } } },
        }),
      );
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({
          branchNamePrefix: "nix/",
          providerInstances: {
            codex: { config: { homePath: "/managed" } },
            codex_work: { driver: "codex", config: { homePath: "/work" } },
          },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, "nix/");
        assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")]?.config, {
          homePath: "/local",
        });
        assert.deepEqual(
          settings.providerInstances[ProviderInstanceId.make("codex_work")]?.config,
          { homePath: "/work" },
        );
        assert.deepEqual(yield* service.managedSettingPaths, [
          ["branchNamePrefix"],
          ["providerInstances", "codex_work"],
        ]);
        const rejected = yield* Effect.flip(service.updateSettings({ branchNamePrefix: "user/" }));
        assert.equal(rejected._tag, "ManagedSettingWriteError");

        const codex = ProviderInstanceId.make("codex");
        const updated = yield* service.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [codex]: { driver: ProviderDriverKind.make("codex"), config: { homePath: "/edited" } },
          },
        });
        assert.deepEqual(updated.providerInstances[codex]?.config, { homePath: "/edited" });
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
          providerInstances: { codex: { driver: "codex", config: { homePath: "/edited" } } },
        });
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    { name: "a wrong-typed key", managed: { defaultAutoPull: "yes" } },
    { name: "an entry map that is not an object", managed: { providerInstances: ["codex"] } },
    { name: "an unknown key", managed: { branchNamePrefx: "typo/" } },
    {
      name: "a key derived from projectSettingsOverrides",
      managed: { projectAutoPullOverrides: { "project-1": true } },
    },
    {
      name: "an entry whose id decodes differently",
      managed: {
        usagePriceOverrides: {
          " gpt-x ": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
        },
      },
    },
    {
      name: "a map key that decodes differently",
      managed: { usageModelAliases: { " foo ": "bar" } },
    },
    {
      name: "a project id that decodes differently",
      managed: { projectSettingsOverrides: { " p1 ": { defaultAutoPull: true } } },
    },
    {
      name: "an unknown nested key",
      managed: { observability: { otlpTracesUrlTypo: "http://collector" } },
    },
    { name: "a value decoding coerces to null", managed: { worktreeSubmodules: "recursve" } },
    {
      name: "a misspelled key inside a whole setting",
      managed: {
        textGenerationModelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          optoins: { reasoningEffort: "high" },
        },
      },
    },
    {
      name: "an unknown key inside a whole entry",
      managed: { providerInstances: { codex_x: { driver: "codex", enabeld: false } } },
    },
    {
      name: "an unknown key inside a nested whole entry",
      managed: {
        projectSettingsOverrides: {
          p1: { providerInstances: { codex: { driver: "codex", enabeld: false } } },
        },
      },
    },
    {
      name: "an entry referencing a missing file",
      managed: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            environment: [
              {
                name: "OPENAI_API_KEY",
                value: { $file: "/nonexistent/t3-secret" },
                sensitive: true,
              },
            ],
          },
        },
      },
    },
  ])("ignores $name in the managed file and keeps enforcing the rest", ({ managed }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-dropped-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ branchNamePrefix: "nix/", ...managed }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, "nix/");
        assert.deepEqual(yield* service.managedSettingPaths, [["branchNamePrefix"]]);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    {
      name: "beside a file reference",
      managed: {
        sourceControlHosts: {
          github: { tokens: { $file: "/nonexistent/t3-token", "github.com": "ghp_INLINE" } },
        },
      },
    },
    {
      name: "in a provider config",
      managed: {
        providerInstances: {
          ag: { driver: "antigravity", config: { apiKey: "AIza_INLINE" } },
        },
      },
    },
    {
      name: "in an entry that does not decode",
      managed: {
        providerInstances: {
          bad: {
            driver: 5,
            environment: [{ name: "OPENAI_API_KEY", value: "sk-INLINE", sensitive: true }],
          },
        },
      },
    },
    {
      name: "under a project override",
      managed: {
        projectSettingsOverrides: {
          p1: {
            providerInstances: {
              codex: {
                environment: [{ name: "OPENAI_API_KEY", value: "sk-INLINE", sensitive: true }],
              },
            },
          },
        },
      },
    },
    {
      name: "in the config of a padded driver",
      managed: {
        providerInstances: {
          ag: { driver: " antigravity", config: { apiKey: "AIza_INLINE" } },
        },
      },
    },
  ])("ignores a managed file with an inline credential $name", ({ managed }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-inline-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ branchNamePrefix: "nix/", ...managed }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, DEFAULT_SERVER_SETTINGS.branchNamePrefix);
        assert.deepEqual(yield* service.managedSettingPaths, []);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    { name: "no value", variable: { name: "TOKEN", sensitive: true } },
    { name: "a blank value", variable: { name: "TOKEN", value: "   ", sensitive: true } },
    { name: "a literal value", variable: { name: "REGION", value: "eu", sensitive: false } },
  ])("accepts a managed environment variable with $name", ({ variable }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-env-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({
          branchNamePrefix: "nix/",
          providerInstances: { codex_x: { driver: "codex", environment: [variable] } },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, "nix/");
        assert.deepEqual(yield* service.managedSettingPaths, [
          ["branchNamePrefix"],
          ["providerInstances", "codex_x"],
        ]);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    {
      name: "object-form model options",
      managed: {
        textGenerationModelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: { reasoningEffort: "high" },
        },
      },
      path: ["textGenerationModelSelection"],
    },
    {
      name: "a legacy provider key",
      managed: { textGenerationModelSelection: { provider: "codex", model: "gpt-5.4" } },
      path: ["textGenerationModelSelection"],
    },
    {
      name: "a legacy enabled flag in a provider config",
      managed: {
        providerInstances: {
          codex_x: { driver: "codex", config: { enabled: false, homePath: "/x" } },
        },
      },
      path: ["providerInstances", "codex_x"],
    },
  ])("keeps a managed value given as $name", ({ managed, path }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-legacy-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ branchNamePrefix: "nix/", ...managed }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* service.getSettings;
        assert.deepEqual(yield* service.managedSettingPaths, [["branchNamePrefix"], path]);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    { name: "sensitive is omitted", extra: {}, valueKey: "value", kept: true },
    { name: "sensitive is misspelled", extra: { sensitve: true }, valueKey: "value", kept: false },
    { name: "value is misspelled", extra: { sensitive: true }, valueKey: "valeu", kept: false },
  ])(
    "never sends a referenced environment secret to clients when $name",
    ({ extra, valueKey, kept }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-leak-" });
        const tokenPath = `${baseDir}/openai-key`;
        yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fs.writeFileString(tokenPath, "sk-file\n");
        yield* fs.writeFileString(
          `${baseDir}/userdata/managed-settings.json`,
          JSON.stringify({
            branchNamePrefix: "nix/",
            providerInstances: {
              codex_x: {
                driver: "codex",
                environment: [
                  { name: "OPENAI_API_KEY", [valueKey]: { $file: tokenPath }, ...extra },
                ],
              },
            },
          }),
        );

        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const settings = yield* service.getSettings;
          assert.notInclude(
            JSON.stringify(ServerSettingsModule.redactServerSettingsForClient(settings)),
            "sk-file",
          );
          assert.deepEqual(
            yield* service.managedSettingPaths,
            kept
              ? [["branchNamePrefix"], ["providerInstances", "codex_x"]]
              : [["branchNamePrefix"]],
          );
        }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
      }),
  );

  it.effect.each([
    {
      name: "a misspelled provider secret field",
      managed: (file: unknown) => ({
        providerInstances: { ag: { driver: "antigravity", config: { apikey: file } } },
      }),
    },
    {
      name: "a secret field of an unknown driver",
      managed: (file: unknown) => ({
        providerInstances: { x: { driver: "antigravityy", config: { apiKey: file } } },
      }),
    },
    {
      name: "a provider display name",
      managed: (file: unknown) => ({
        providerInstances: { codex_x: { driver: "codex", displayName: file } },
      }),
    },
    { name: "a plain setting", managed: (file: unknown) => ({ branchNamePrefix: file }) },
  ])("drops a managed file reference in $name", ({ managed }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-misplaced-" });
      const secretPath = `${baseDir}/secret`;
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(secretPath, "sk-FILESECRET\n");
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ defaultAutoPull: true, ...managed({ $file: secretPath }) }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.isTrue(settings.defaultAutoPull);
        assert.deepEqual(yield* service.managedSettingPaths, [["defaultAutoPull"]]);
        assert.notInclude(
          JSON.stringify(ServerSettingsModule.redactServerSettingsForClient(settings)),
          "sk-FILESECRET",
        );
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect.each([
    {
      name: "valid host",
      host: { kind: "eas", id: "expo", label: "Expo", accessToken: "inline-token" },
    },
    { name: "invalid host", host: { accessToken: "inline-token" } },
  ])("rejects inline managed device credentials in a $name", ({ host }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-device-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ branchNamePrefix: "nix/", easDeviceHosts: [host] }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, DEFAULT_SERVER_SETTINGS.branchNamePrefix);
        assert.deepEqual(settings.easDeviceHosts, []);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect("reads managed file references in every credential position", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-positions-" });
      const secretPath = `${baseDir}/secret`;
      const file = { $file: secretPath };
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(secretPath, "sk-FILESECRET\n");
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({
          providerInstances: {
            ag: { driver: "antigravity", config: { apiKey: file } },
            codex_x: {
              driver: "codex",
              environment: [{ name: "OPENAI_API_KEY", value: file, sensitive: true }],
            },
          },
          sourceControlHosts: { github: { tokens: { "github.com": file } } },
          usageLimitSources: {
            hub: { kind: "cliproxy", url: "http://hub.test", managementKey: file },
          },
          easDeviceHosts: [{ kind: "eas", id: "expo", label: "Expo", accessToken: file }],
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.deepEqual(yield* service.managedSettingPaths, [
          ["providerInstances", "ag"],
          ["providerInstances", "codex_x"],
          ["sourceControlHosts", "github", "tokens", "github.com"],
          ["usageLimitSources", "hub"],
          ["easDeviceHosts"],
        ]);
        const ag = settings.providerInstances[ProviderInstanceId.make("ag")];
        assert.equal((ag?.config as { apiKey?: string } | undefined)?.apiKey, "sk-FILESECRET");
        assert.equal(
          settings.providerInstances[ProviderInstanceId.make("codex_x")]?.environment?.[0]?.value,
          "sk-FILESECRET",
        );
        assert.deepEqual(settings.sourceControlHosts.github?.tokens, {
          "github.com": "sk-FILESECRET",
        });
        assert.equal(Object.values(settings.usageLimitSources)[0]?.managementKey, "sk-FILESECRET");
        assert.equal(settings.easDeviceHosts[0]?.accessToken, "sk-FILESECRET");
        assert.notInclude(
          JSON.stringify(ServerSettingsModule.redactServerSettingsForClient(settings)),
          "sk-FILESECRET",
        );
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect("keeps a managed null and a referenced secret marked as redacted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-null-" });
      const tokenPath = `${baseDir}/openai-key`;
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(tokenPath, "sk-file\n");
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({
          defaultThreadEnvMode: null,
          providerInstances: {
            codex_x: {
              driver: "codex",
              environment: [
                {
                  name: "OPENAI_API_KEY",
                  value: { $file: tokenPath },
                  sensitive: true,
                  valueRedacted: true,
                },
              ],
            },
          },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(
          settings.providerInstances[ProviderInstanceId.make("codex_x")]?.environment?.[0]?.value,
          "sk-file",
        );
        assert.deepEqual(yield* service.managedSettingPaths, [
          ["defaultThreadEnvMode"],
          ["providerInstances", "codex_x"],
        ]);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect("hands a dropped managed map key back to the user", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-alias-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(
        `${baseDir}/userdata/managed-settings.json`,
        JSON.stringify({ usageModelAliases: { " foo ": "bar" } }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const updated = yield* service.updateSettings({ usageModelAliases: { foo: "baz" } });
        assert.deepEqual(updated.usageModelAliases, { foo: "baz" });
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );

  it.effect("reads managed credentials only from referenced files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-managed-secrets-" });
      const managedPath = `${baseDir}/userdata/managed-settings.json`;
      const tokenPath = `${baseDir}/github-token`;
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(tokenPath, "file-token\n");
      yield* fs.writeFileString(
        managedPath,
        JSON.stringify({
          branchNamePrefix: "nix/",
          sourceControlHosts: { github: { tokens: { "github.com": "inline" } } },
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.equal(settings.branchNamePrefix, DEFAULT_SERVER_SETTINGS.branchNamePrefix);
        assert.equal(settings.sourceControlHosts.github?.tokens, undefined);
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));

      yield* fs.writeFileString(
        managedPath,
        JSON.stringify({
          sourceControlHosts: { github: { tokens: { "github.com": { $file: tokenPath } } } },
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.deepEqual(settings.sourceControlHosts.github?.tokens, {
          "github.com": "file-token",
        });
        assert.notDeepEqual(
          ServerSettingsModule.redactServerSettingsForClient(settings).sourceControlHosts.github
            ?.tokens,
          { "github.com": "file-token" },
        );
        yield* service.updateSettings({ defaultAutoPull: true });
        const config = yield* ServerConfig.ServerConfig;
        assert.notInclude(yield* fs.readFileString(config.settingsPath), "file-token");
      }).pipe(Effect.provide(layerServerSettingsWithManagedFile(baseDir)));
    }),
  );
});

const layerSharedServerSettings = (
  options: {
    readonly managed?: boolean;
    readonly secretStoreLayer?: typeof ServerSecretStore.layer;
  } = {},
) =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(options.secretStoreLayer ?? ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = yield* Path.Path;
          return {
            ...config,
            sharedSettingsPath: path.join(config.baseDir, "dotfiles", "t3code-settings.json"),
            ...(options.managed
              ? {
                  managedSettingsPath: path.join(config.baseDir, "system", "managed-settings.json"),
                }
              : {}),
          };
        }),
      ).pipe(
        Layer.provide(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-shared-settings-test-" }),
          ),
        ),
      ),
    ),
  );

const writeSharedSettings = (contents: unknown) =>
  Effect.gen(function* () {
    const { sharedSettingsPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(sharedSettingsPath!), { recursive: true });
    const raw = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
    yield* writeFileStringAtomically({ filePath: sharedSettingsPath!, contents: raw });
    return raw;
  });

const layerSecretStoreFailingSets = (fails: (secretName: string) => boolean) =>
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
      ...store,
      set: (secretName: string, value: Uint8Array) =>
        fails(secretName)
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: "provider environment secret",
                cause: new Error("Secret storage unavailable"),
              }),
            )
          : store.set(secretName, value),
    })),
  ).pipe(Layer.provide(ServerSecretStore.layer));

const githubTokenSecretName = (serverHost: string) =>
  sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost });
const providerEnvSecretName = (instanceId: string, variable: string) =>
  `provider-env-${Buffer.from(instanceId).toString("base64url")}-${Buffer.from(variable).toString("base64url")}`;

const readStoredSecret = (secretName: string) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const stored = yield* store.get(secretName);
    return Option.map(stored, (value) => new TextDecoder().decode(value));
  });

const writeManagedSettings = (contents: unknown) =>
  Effect.gen(function* () {
    const { managedSettingsPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(managedSettingsPath!), { recursive: true });
    yield* fs.writeFileString(managedSettingsPath!, JSON.stringify(contents));
  });

const SHARED_SETTINGS = {
  defaultAutoPull: true,
  worktreesDirectory: "/shared/worktrees",
  responseStreamingMode: "turn",
  automaticGitFetchInterval: 600_000,
  observability: { otlpTracesUrl: "http://collector.test:4318/v1/traces" },
  favorites: [{ provider: "codex", model: "gpt-5" }],
  providerInstances: {
    codex_work: {
      driver: "codex",
      environment: [
        { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true },
        { name: "OPENAI_BASE_URL", value: "https://llm.example.test", sensitive: false },
      ],
      config: { binaryPath: "/opt/codex/bin/codex", enabled: true },
    },
  },
  sourceControlHosts: {
    bitbucket: { email: "shared@example.com", accessToken: "bb-shared" },
    github: { tokens: { "github.com": "ghp_shared" } },
  },
  projectSettingsFolded: true,
};

it.layer(NodeServices.layer)("shared server settings", (it) => {
  it.effect("applies the shared file beneath settings.json", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings(SHARED_SETTINGS);
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ worktreesDirectory: "/local/worktrees" }),
      );

      const settings = yield* service.getSettings;

      assert.isTrue(settings.defaultAutoPull);
      assert.equal(settings.responseStreamingMode, "turn");
      assert.equal(settings.worktreesDirectory, "/local/worktrees");
      assert.equal(settings.observability.otlpTracesUrl, "http://collector.test:4318/v1/traces");
      assert.equal(
        settings.providerInstances[ProviderInstanceId.make("codex_work")]?.environment?.[0]?.value,
        "sk-shared",
      );
      assert.equal(settings.sourceControlHosts.bitbucket?.accessToken, "bb-shared");
      // A migration marker in the shared file does not stand in for this machine's fold.
      assert.isFalse(settings.projectSettingsFolded);
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("writes only the patched key to settings.json and never the shared file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const sharedRaw = yield* writeSharedSettings(SHARED_SETTINGS);

      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* service.getSettings,
      );
      yield* service.updateSettings({ enableAgentBrowserAccess: false });
      // Clients echo whole maps back with secrets redacted.
      const updated = yield* service.updateSettings({
        providerInstances: forClient.providerInstances,
        sourceControlHosts: forClient.sourceControlHosts,
      });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        enableAgentBrowserAccess: false,
      });
      assert.equal(yield* fs.readFileString(config.sharedSettingsPath!), sharedRaw);
      assert.isTrue(
        Option.isNone(
          yield* secrets.get(
            sourceControlHostSecretName({
              kind: "bitbucket",
              field: "accessToken",
              serverHost: null,
            }),
          ),
        ),
      );
      assert.isTrue(updated.defaultAutoPull);
      assert.equal(
        updated.providerInstances[ProviderInstanceId.make("codex_work")]?.environment?.[0]?.value,
        "sk-shared",
      );
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps a value set back to its default when the shared file differs", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        defaultAutoPull: true,
        worktreesDirectory: "/shared/worktrees",
      });

      const updated = yield* service.updateSettings({ defaultAutoPull: false });
      assert.isFalse(updated.defaultAutoPull);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultAutoPull: false,
      });

      // Reloading from disk keeps the local value over the shared one.
      yield* service.start;
      const reloaded = yield* service.getSettings;
      assert.isFalse(reloaded.defaultAutoPull);
      assert.equal(reloaded.worktreesDirectory, "/shared/worktrees");
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("migrates settings.json without copying shared values into it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const sharedRaw = yield* writeSharedSettings(SHARED_SETTINGS);
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providers: { codex: { binaryPath: "/usr/local/bin/codex" } } }),
      );

      const settings = yield* service.getSettings;

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        providerInstances: {
          codex: { driver: "codex", config: { binaryPath: "/usr/local/bin/codex" } },
        },
      });
      assert.equal(yield* fs.readFileString(config.sharedSettingsPath!), sharedRaw);
      assert.isTrue(settings.defaultAutoPull);
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex_work")], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        environment: [
          { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true },
          { name: "OPENAI_BASE_URL", value: "https://llm.example.test", sensitive: false },
        ],
        config: { binaryPath: "/opt/codex/bin/codex" },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("ignores a malformed shared file and leaves settings.json untouched", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings('{"defaultAutoPull": tru');
      const local = JSON.stringify({
        worktreesDirectory: "/local/worktrees",
        providers: { codex: { binaryPath: "/usr/local/bin/codex" } },
      });
      yield* fs.writeFileString(config.settingsPath, local);

      const settings = yield* service.getSettings;

      assert.isFalse(settings.defaultAutoPull);
      assert.isFalse(settings.continueThreadsAfterServerUpdate);
      assert.equal(settings.worktreesDirectory, "/local/worktrees");
      assert.equal(yield* fs.readFileString(config.settingsPath), local);
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("reloads when the shared file changes and survives a malformed edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* writeSharedSettings({ defaultAutoPull: false });
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeSharedSettings({ defaultAutoPull: true });
        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.isTrue(Option.getOrUndefined(change)?.defaultAutoPull);

        yield* writeSharedSettings('{"defaultAutoPull": tru');
        const broken = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.isFalse(Option.getOrUndefined(broken)?.defaultAutoPull);

        yield* writeSharedSettings({ defaultAutoPull: true });
        const repaired = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.isTrue(Option.getOrUndefined(repaired)?.defaultAutoPull);
      }),
    ).pipe(TestClock.withLive, Effect.provide(layerSharedServerSettings())),
  );
  it.effect("saves an edited shared provider instance as a whole entry", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_work");
      const codex = ProviderDriverKind.make("codex");
      yield* writeSharedSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            config: { binaryPath: "/opt/codex", homePath: "/shared/codex-home" },
          },
        },
      });
      const readLocal = Effect.map(fs.readFileString(config.settingsPath), JSON.parse);

      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: codex,
          config: { binaryPath: "/usr/bin/codex", homePath: "/shared/codex-home" },
        },
      });
      assert.deepEqual(yield* readLocal, {
        providerInstances: {
          codex_work: {
            driver: "codex",
            config: { binaryPath: "/usr/bin/codex", homePath: "/shared/codex-home" },
          },
        },
      });

      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          driver: codex,
          enabled: false,
          config: { binaryPath: "/opt/codex", homePath: "/shared/codex-home" },
        },
      });
      assert.deepEqual(yield* readLocal, {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: false,
            config: { binaryPath: "/opt/codex", homePath: "/shared/codex-home" },
          },
        },
      });

      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: { driver: codex, config: { binaryPath: "/opt/codex" } },
      });
      yield* service.start;
      assert.deepEqual((yield* service.getSettings).providerInstances[instanceId], {
        driver: codex,
        config: { binaryPath: "/opt/codex" },
      });

      const claude = ProviderDriverKind.make("claudeAgent");
      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: { driver: claude, config: { homePath: "/home/me/.claude" } },
      });
      assert.deepEqual(yield* readLocal, {
        providerInstances: {
          codex_work: { driver: "claudeAgent", config: { homePath: "/home/me/.claude" } },
        },
      });
      assert.deepEqual((yield* service.getSettings).providerInstances[instanceId], {
        driver: claude,
        config: { homePath: "/home/me/.claude" },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("moves an inherited secret into the store once its instance is edited", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_work");
      yield* writeSharedSettings(SHARED_SETTINGS);
      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* service.getSettings,
      );

      const updated = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: { ...forClient.providerInstances[instanceId]!, enabled: false },
      });

      const raw = yield* fs.readFileString(config.settingsPath);
      assert.isFalse(raw.includes("sk-shared"));
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_work.environment[0], {
        name: "OPENAI_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      });
      assert.equal(updated.providerInstances[instanceId]?.environment?.[0]?.value, "sk-shared");
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("saves a changed shared model selection or cleanup rule as a whole value", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const projectId = ProjectId.make("project-shared");
      const rules = {
        worktreeKeepWhen: "uncommitted-changes",
        worktreeAfterDays: 7,
        worktreeSettledAfterDays: null,
        worktreeOnMerge: true,
        worktreeOnDelete: false,
        worktreeUnchanged: false,
      } as const;
      yield* writeSharedSettings({
        defaultModelSelection: { instanceId: "codex", model: "gpt-5" },
        worktreeCleanup: { mode: "custom", rules },
        projectSettingsOverrides: {
          [projectId]: { defaultModelSelection: { instanceId: "codex", model: "gpt-5" } },
        },
      });

      const updated = yield* service.updateSettings({
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-mini",
        },
        worktreeCleanup: { mode: "custom", rules: { ...rules, worktreeAfterDays: 14 } },
        projectSettingsOverrides: {
          [projectId]: {
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-nano",
            },
          },
        },
      });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultModelSelection: { instanceId: "codex", model: "gpt-5-mini" },
        worktreeCleanup: { mode: "custom", rules: { ...rules, worktreeAfterDays: 14 } },
        projectSettingsOverrides: {
          [projectId]: { defaultModelSelection: { instanceId: "codex", model: "gpt-5-nano" } },
        },
      });
      assert.equal(updated.defaultModelSelection?.model, "gpt-5-mini");
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("migrates this machine's legacy codex path over a shared codex instance", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        providerInstances: { codex: { driver: "codex", config: { binaryPath: "/opt/codex" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providers: { codex: { binaryPath: "/usr/local/bin/codex" } } }),
      );

      const settings = yield* service.getSettings;

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        providerInstances: {
          codex: { driver: "codex", config: { binaryPath: "/usr/local/bin/codex" } },
        },
      });
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")]?.config, {
        binaryPath: "/usr/local/bin/codex",
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps a shared cursor instance that provider history marks as used", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("cursor");
      yield* writeSharedSettings({
        providerInstances: {
          cursor: { driver: "cursor", enabled: true, config: { binaryPath: "/opt/cursor-agent" } },
        },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providers: { codex: { binaryPath: "/usr/local/bin/codex" } } }),
      );

      const settings = yield* service.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        enabled: true,
        config: { binaryPath: "/opt/cursor-agent" },
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        providerInstances: {
          codex: { driver: "codex", config: { binaryPath: "/usr/local/bin/codex" } },
        },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    {
      driver: "cursor",
      shared: { driver: "cursor", enabled: true, config: { binaryPath: "/opt/cursor-agent" } },
      legacy: { enabled: true },
      expected: { driver: "cursor", enabled: true, config: { binaryPath: "/opt/cursor-agent" } },
      local: {},
    },
    {
      driver: "codex",
      shared: { driver: "codex", config: { binaryPath: "/opt/codex" } },
      legacy: { enabled: false },
      expected: { driver: "codex", enabled: false, config: { binaryPath: "/opt/codex" } },
      local: {
        providerInstances: {
          codex: { driver: "codex", enabled: false, config: { binaryPath: "/opt/codex" } },
        },
      },
    },
    {
      driver: "codex",
      shared: { driver: "codex", config: { binaryPath: "/opt/codex" } },
      legacy: { enabled: true },
      expected: { driver: "codex", config: { binaryPath: "/opt/codex" } },
      local: {},
    },
  ])(
    "keeps the shared $driver config under a legacy enabled-only entry",
    ({ driver, shared, legacy, expected, local }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* writeSharedSettings({ providerInstances: { [driver]: shared } });
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ providers: { [driver]: legacy } }),
        );

        const settings = yield* service.getSettings;

        assert.deepEqual(settings.providerInstances[ProviderInstanceId.make(driver)], {
          ...expected,
          driver: ProviderDriverKind.make(expected.driver),
        });
        assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), local);
      }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    { driver: "codex", legacy: { codex: { enabled: false } }, usedProvider: undefined },
    { driver: "cursor", legacy: { codex: {} }, usedProvider: "cursor" },
  ])(
    "stores a shared $driver secret when legacy migration saves its entry",
    ({ driver, legacy, usedProvider }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        if (usedProvider !== undefined) yield* recordProviderUsage(usedProvider);
        yield* writeSharedSettings({
          providerInstances: {
            [driver]: {
              driver,
              environment: [{ name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true }],
              config: { binaryPath: `/opt/${driver}` },
            },
          },
        });
        yield* fs.writeFileString(config.settingsPath, JSON.stringify({ providers: legacy }));

        const settings = yield* service.getSettings;

        const raw = yield* fs.readFileString(config.settingsPath);
        assert.notInclude(raw, "sk-shared");
        assert.deepEqual(JSON.parse(raw).providerInstances[driver].environment, [
          { name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
        ]);
        assert.deepEqual(
          yield* readStoredSecret(
            `provider-env-${Buffer.from(driver).toString("base64url")}-T1BFTkFJX0FQSV9LRVk`,
          ),
          Option.some("sk-shared"),
        );
        assert.equal(
          settings.providerInstances[ProviderInstanceId.make(driver)]?.environment?.[0]?.value,
          "sk-shared",
        );
      }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  const OPENAI_KEY_SECRET = "provider-env-Y29kZXg-T1BFTkFJX0FQSV9LRVk";
  const OTHER_KEY_SECRET = "provider-env-Y29kZXg-T1RIRVJfS0VZ";
  const LEGACY_CODEX_DISABLED = JSON.stringify({ providers: { codex: { enabled: false } } });
  const writeSharedCodexSecrets = writeSharedSettings({
    providerInstances: {
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true },
          { name: "OTHER_KEY", value: "other-shared", sensitive: true },
        ],
        config: {},
      },
    },
  });

  it.effect.each([{ failing: OPENAI_KEY_SECRET }, { failing: OTHER_KEY_SECRET }])(
    "leaves settings.json and the store alone when storing $failing fails during migration",
    ({ failing }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* writeSharedCodexSecrets;
        yield* fs.writeFileString(config.settingsPath, LEGACY_CODEX_DISABLED);

        const settings = yield* service.getSettings;

        assert.equal(yield* fs.readFileString(config.settingsPath), LEGACY_CODEX_DISABLED);
        assert.deepEqual(yield* readStoredSecret(OPENAI_KEY_SECRET), Option.none());
        assert.deepEqual(yield* readStoredSecret(OTHER_KEY_SECRET), Option.none());
        assert.isFalse(settings.providerInstances[ProviderInstanceId.make("codex")]?.enabled);
      }).pipe(
        Effect.provide(
          layerSharedServerSettings({
            secretStoreLayer: layerSecretStoreFailingSets((secretName) => secretName === failing),
          }),
        ),
      ),
  );

  it.effect(
    "stores shared secrets on the first save after a migration could not store them",
    () => {
      let storeAvailable = false;
      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* writeSharedCodexSecrets;
        yield* fs.writeFileString(config.settingsPath, LEGACY_CODEX_DISABLED);
        yield* service.getSettings;
        storeAvailable = true;

        const updated = yield* service.updateSettings({ defaultAutoPull: true });

        const raw = yield* fs.readFileString(config.settingsPath);
        assert.notInclude(raw, "sk-shared");
        assert.notInclude(raw, "other-shared");
        const persisted = JSON.parse(raw);
        assert.isUndefined(persisted.providers);
        assert.deepEqual(persisted.providerInstances.codex.environment, [
          { name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
          { name: "OTHER_KEY", value: "", sensitive: true, valueRedacted: true },
        ]);
        assert.deepEqual(yield* readStoredSecret(OPENAI_KEY_SECRET), Option.some("sk-shared"));
        assert.deepEqual(yield* readStoredSecret(OTHER_KEY_SECRET), Option.some("other-shared"));
        const codex = updated.providerInstances[ProviderInstanceId.make("codex")];
        assert.isFalse(codex?.enabled);
        assert.equal(codex?.environment?.[0]?.value, "sk-shared");
      }).pipe(
        Effect.provide(
          layerSharedServerSettings({
            secretStoreLayer: layerSecretStoreFailingSets(() => !storeAvailable),
          }),
        ),
      );
    },
  );

  it.effect("disables a history-enabled shared cursor without pinning it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("cursor");
      yield* writeSharedSettings({
        providerInstances: { cursor: { driver: "cursor", config: { binaryPath: "/opt/cursor" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providers: { cursor: { enabled: false } } }),
      );

      const settings = yield* service.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { binaryPath: "/opt/cursor" },
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("layers the retired source control keys over shared hosts of the same kind", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const marker = "\u2022\u2022\u2022\u2022\u2022\u2022";
      const gheTokenSecret = `github-token-${Buffer.from("ghe.acme.test").toString("base64url")}`;
      yield* secrets.set(gheTokenSecret, new TextEncoder().encode("ghe-saved"));
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("bb-saved"));
      yield* writeSharedSettings({
        sourceControlHosts: {
          bitbucket: { email: "shared@example.com", accessToken: "bb-shared" },
          github: { tokens: { "github.com": "ghp_shared" } },
        },
      });
      const local = {
        bitbucket: { accessToken: marker },
        github: {
          hosts: { "ghe.acme.test": { account: "work" } },
          tokens: { "ghe.acme.test": marker },
        },
      };
      yield* fs.writeFileString(config.settingsPath, JSON.stringify(local));

      const loaded = (yield* service.getSettings).sourceControlHosts;

      assert.deepEqual(loaded.bitbucket, { email: "shared@example.com", accessToken: "bb-saved" });
      assert.deepEqual(loaded.github, {
        hosts: { "ghe.acme.test": { account: "work" } },
        tokens: { "github.com": "ghp_shared", "ghe.acme.test": "ghe-saved" },
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        sourceControlHosts: local,
      });
      assert.deepEqual(yield* readStoredSecret(gheTokenSecret), Option.none());
      assert.deepEqual(yield* readStoredSecret("bitbucket-access-token"), Option.none());
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    {
      name: "a mixed-case host key",
      shared: { sourceControlHosts: { github: { tokens: { "GitHub.com": "ghp_shared" } } } },
      secretName: githubTokenSecretName("github.com"),
    },
    {
      name: "a padded host key",
      shared: { sourceControlHosts: { github: { tokens: { " github.com ": "ghp_shared" } } } },
      secretName: githubTokenSecretName("github.com"),
    },
    {
      name: "an explicitly unredacted environment value",
      shared: {
        providerInstances: {
          codex_work: {
            driver: "codex",
            environment: [
              { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true, valueRedacted: false },
            ],
            config: {},
          },
        },
      },
      secretName: providerEnvSecretName("codex_work", "OPENAI_API_KEY"),
    },
    {
      name: "a non-string secret field",
      shared: {
        providerInstances: {
          antigravity_work: {
            driver: "antigravity",
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-shared", sensitive: true }],
            config: { apiKey: null },
          },
        },
      },
      secretName: providerEnvSecretName("antigravity_work", "OPENROUTER_API_KEY"),
    },
    {
      name: "a padded price override model id",
      shared: {
        usagePriceOverrides: {
          " vendor/model ": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
        },
      },
      secretName: undefined,
    },
  ])("keeps inherited shared values with $name out of settings.json", ({ shared, secretName }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings(shared);

      yield* service.updateSettings({ defaultAutoPull: true });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultAutoPull: true,
      });
      if (secretName !== undefined) {
        assert.deepEqual(yield* readStoredSecret(secretName), Option.none());
      }
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps a mixed-case shared host token out of settings.json on a legacy load", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "GitHub.com": "ghp_shared" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ github: { tokens: { "ghe.x": "plain_local" } } }),
      );

      const loaded = (yield* service.getSettings).sourceControlHosts;

      assert.deepEqual(loaded.github?.tokens, {
        "github.com": "ghp_shared",
        "ghe.x": "plain_local",
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        sourceControlHosts: {
          github: { tokens: { "ghe.x": "\u2022\u2022\u2022\u2022\u2022\u2022" } },
        },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("lets a shared token win over a retired placeholder with nothing stored", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "github.com": "ghp_shared" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          github: { tokens: { "github.com": "\u2022\u2022\u2022\u2022\u2022\u2022" } },
        }),
      );

      const loaded = (yield* service.getSettings).sourceControlHosts;

      assert.deepEqual(loaded.github?.tokens, { "github.com": "ghp_shared" });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    { name: "with a shared host", sharedTokens: { "github.com": "ghp_shared" } },
    { name: "without a shared file", sharedTokens: undefined },
  ])(
    "keeps settings.json's own source control host over the retired key $name",
    ({ sharedTokens }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        if (sharedTokens !== undefined) {
          yield* writeSharedSettings({ sourceControlHosts: { github: { tokens: sharedTokens } } });
        }
        const ownHost = { github: { hosts: { "local.test": { account: "local" } } } };
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            sourceControlHosts: ownHost,
            github: { hosts: { "legacy.test": { account: "legacy" } } },
          }),
        );

        const loaded = (yield* service.getSettings).sourceControlHosts;

        assert.deepEqual(loaded.github, {
          ...ownHost.github,
          ...(sharedTokens === undefined ? {} : { tokens: sharedTokens }),
        });
        assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
          sourceControlHosts: ownHost,
        });
      }).pipe(
        Effect.provide(
          sharedTokens === undefined
            ? layerServerSettingsWithSecrets()
            : layerSharedServerSettings(),
        ),
      ),
  );

  it.effect("removes stored shared secrets when the migrated settings file cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let settingsPathToFail: string | undefined;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          toPath === settingsPathToFail
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  description: "Forced settings write failure.",
                }),
              )
            : fileSystem.rename(fromPath, toPath),
      });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* writeSharedCodexSecrets;
        yield* fileSystem.writeFileString(config.settingsPath, LEGACY_CODEX_DISABLED);
        settingsPathToFail = config.settingsPath;

        const loaded = yield* Effect.exit(service.getSettings);

        assert.equal(loaded._tag, "Failure");
        assert.equal(yield* fileSystem.readFileString(config.settingsPath), LEGACY_CODEX_DISABLED);
        assert.deepEqual(yield* readStoredSecret(OPENAI_KEY_SECRET), Option.none());
        assert.deepEqual(yield* readStoredSecret(OTHER_KEY_SECRET), Option.none());
      }).pipe(
        Effect.provide(
          layerSharedServerSettings().pipe(
            Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
          ),
        ),
      );
    }),
  );

  const GITHUB_COM_TOKEN_SECRET = sourceControlHostSecretName({
    kind: "github",
    field: "tokens",
    serverHost: "github.com",
  });

  it.effect("keeps settings.json's token over a shared host spelled two ways", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "github.com": "B", "GitHub.com": "A" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          sourceControlHosts: { github: { tokens: { "github.com": "plain_local" } } },
        }),
      );

      assert.deepEqual((yield* service.getSettings).sourceControlHosts.github?.tokens, {
        "github.com": "plain_local",
      });
      yield* service.updateSettings({ defaultAutoPull: true });

      assert.deepEqual(
        yield* readStoredSecret(GITHUB_COM_TOKEN_SECRET),
        Option.some("plain_local"),
      );
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultAutoPull: true,
        sourceControlHosts: {
          github: { tokens: { "github.com": "\u2022\u2022\u2022\u2022\u2022\u2022" } },
        },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps the last of two spellings of one host within settings.json", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "github.com": "ghp_shared" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          sourceControlHosts: {
            github: { tokens: { "GitHub.com": "first", "github.com": "last" } },
          },
        }),
      );

      assert.deepEqual((yield* service.getSettings).sourceControlHosts.github?.tokens, {
        "github.com": "last",
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("does not pin a retired token that matches a shared one but for its host's case", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "github.com": "ghp_shared" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ github: { tokens: { "GitHub.com": "ghp_shared" } } }),
      );

      assert.deepEqual((yield* service.getSettings).sourceControlHosts.github?.tokens, {
        "github.com": "ghp_shared",
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps a mixed-case shared host token out of a provider migration's rewrite", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "GitHub.com": "ghp_shared" } } },
      });
      yield* fs.writeFileString(config.settingsPath, LEGACY_CODEX_DISABLED);

      yield* service.getSettings;

      const raw = yield* fs.readFileString(config.settingsPath);
      assert.notInclude(raw, "ghp_shared");
      assert.deepEqual(JSON.parse(raw), {
        providerInstances: { codex: { driver: "codex", enabled: false, config: {} } },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("keeps a token stored under its new name behind a retired placeholder", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(GITHUB_COM_TOKEN_SECRET, new TextEncoder().encode("LOCAL_NEW"));
      yield* writeSharedSettings({
        sourceControlHosts: { github: { tokens: { "github.com": "SHARED" } } },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          github: { tokens: { "github.com": "\u2022\u2022\u2022\u2022\u2022\u2022" } },
        }),
      );

      assert.deepEqual((yield* service.getSettings).sourceControlHosts.github?.tokens, {
        "github.com": "LOCAL_NEW",
      });
      yield* service.updateSettings({ defaultAutoPull: true });

      assert.deepEqual(yield* readStoredSecret(GITHUB_COM_TOKEN_SECRET), Option.some("LOCAL_NEW"));
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultAutoPull: true,
        sourceControlHosts: {
          github: { tokens: { "github.com": "\u2022\u2022\u2022\u2022\u2022\u2022" } },
        },
      });
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("lets a shared bitbucket key win over a retired placeholder with nothing stored", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        sourceControlHosts: {
          bitbucket: { email: "shared@example.com", accessToken: "bb-shared" },
        },
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ bitbucket: { accessToken: "\u2022\u2022\u2022\u2022\u2022\u2022" } }),
      );

      assert.deepEqual((yield* service.getSettings).sourceControlHosts.bitbucket, {
        email: "shared@example.com",
        accessToken: "bb-shared",
      });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  const DUPLICATE_GITHUB_TOKENS = { "GitHub.com": "first", "github.com": "last" };

  it.effect.each([
    {
      source: "the shared file",
      shared: { sourceControlHosts: { github: { tokens: DUPLICATE_GITHUB_TOKENS } } },
      local: {},
      inShared: true,
    },
    {
      source: "settings.json",
      shared: {},
      local: { sourceControlHosts: { github: { tokens: DUPLICATE_GITHUB_TOKENS } } },
      inShared: false,
    },
    {
      source: "a retired github key",
      shared: { sourceControlHosts: { github: { tokens: { "ghe.test": "ghp_shared" } } } },
      local: { github: { tokens: DUPLICATE_GITHUB_TOKENS } },
      inShared: false,
    },
  ])("warns when $source spells one secret host two ways", ({ shared, local, inShared }) => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      const [text, annotations] = Array.isArray(message) ? message : [message];
      if (text === "a settings file names one secret host more than once; the last wins") {
        warnings.push(annotations);
      }
    });
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings(shared);
      yield* fs.writeFileString(config.settingsPath, JSON.stringify(local));

      const tokens = (yield* service.getSettings).sourceControlHosts.github?.tokens as
        | Record<string, unknown>
        | undefined;
      assert.equal(tokens?.["github.com"], "last");

      assert.deepEqual(warnings, [
        { path: inShared ? config.sharedSettingsPath : config.settingsPath, duplicates: 1 },
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerSharedServerSettings(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "without a shared file", withShared: false },
    { name: "beneath a shared host", withShared: true },
  ])("migrates a retired placeholder whose new name cannot be read $name", ({ withShared }) => {
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        get: (secretName: string) =>
          secretName === githubTokenSecretName("github.com")
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: "source control token",
                  cause: new Error("Secret storage unavailable"),
                }),
              )
            : store.get(secretName),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerSettings = withShared
      ? layerSharedServerSettings({ secretStoreLayer: layerSecret })
      : ServerSettingsModule.layer.pipe(
          Layer.provideMerge(layerSecret),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3code-settings-probe-test-" }),
            ),
          ),
        );
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const marker = "\u2022\u2022\u2022\u2022\u2022\u2022";
      if (withShared) {
        yield* writeSharedSettings({
          sourceControlHosts: { github: { tokens: { "github.com": "ghp_shared" } } },
        });
      }
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ github: { tokens: { "github.com": marker } } }),
      );

      yield* Effect.exit(service.getSettings);

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        sourceControlHosts: { github: { tokens: { "github.com": marker } } },
      });
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("keeps a cleared thread env mode over the shared value across a reload", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({ defaultThreadEnvMode: "worktree" });

      const updated = yield* service.updateSettings({ defaultThreadEnvMode: null });

      assert.isNull(updated.defaultThreadEnvMode);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultThreadEnvMode: null,
      });
      yield* service.start;
      assert.isNull((yield* service.getSettings).defaultThreadEnvMode);
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("follows the shared file again once an edited instance is reverted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_work");
      const sharedInstance = (apiKey: string) => ({
        providerInstances: {
          codex_work: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", value: apiKey, sensitive: true }],
            config: { binaryPath: "/opt/codex" },
          },
        },
      });
      const upsertBinaryPath = (binaryPath: string) =>
        Effect.gen(function* () {
          const forClient = ServerSettingsModule.redactServerSettingsForClient(
            yield* service.getSettings,
          );
          return yield* service.updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: { ...forClient.providerInstances[instanceId]!, config: { binaryPath } },
          });
        });
      yield* writeSharedSettings(sharedInstance("sk-shared"));

      const storedApiKey = readStoredSecret("provider-env-Y29kZXhfd29yaw-T1BFTkFJX0FQSV9LRVk");

      yield* upsertBinaryPath("/usr/bin/codex");
      assert.notDeepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
      assert.deepEqual(yield* storedApiKey, Option.some("sk-shared"));
      const reverted = yield* upsertBinaryPath("/opt/codex");

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});
      assert.deepEqual(yield* storedApiKey, Option.none());
      assert.equal(reverted.providerInstances[instanceId]?.environment?.[0]?.value, "sk-shared");
      yield* writeSharedSettings(sharedInstance("sk-rotated"));
      yield* service.start;
      assert.equal(
        (yield* service.getSettings).providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-rotated",
      );
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    {
      placeholder: "environment variable",
      instanceId: "codex_work",
      sharedSecretName: "provider-env-Y29kZXhfd29yaw-T1BFTkFJX0FQSV9LRVk",
      shared: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true },
          { name: "LOCAL_TOKEN", value: "", sensitive: true },
        ],
        config: {},
      },
      setLocal: (instance: ProviderInstanceConfig): ProviderInstanceConfig => ({
        ...instance,
        environment: (instance.environment ?? []).map((variable) =>
          variable.name === "LOCAL_TOKEN" ? { ...variable, value: "tok-local" } : variable,
        ),
      }),
      expected: {
        driver: ProviderDriverKind.make("codex"),
        environment: [
          { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true, valueRedacted: true },
          { name: "LOCAL_TOKEN", value: "tok-local", sensitive: true, valueRedacted: true },
        ],
        config: {},
      },
    },
    {
      placeholder: "config field",
      instanceId: "antigravity_work",
      sharedSecretName: "provider-env-YW50aWdyYXZpdHlfd29yaw-QVBJX1RPS0VO",
      shared: {
        driver: "antigravity",
        environment: [{ name: "API_TOKEN", value: "sk-shared", sensitive: true }],
        config: { apiKey: "" },
      },
      setLocal: (instance: ProviderInstanceConfig): ProviderInstanceConfig => ({
        ...instance,
        config: { ...(instance.config as object), apiKey: "tok-local" },
      }),
      expected: {
        driver: ProviderDriverKind.make("antigravity"),
        environment: [
          { name: "API_TOKEN", value: "sk-shared", sensitive: true, valueRedacted: true },
        ],
        config: { apiKey: "tok-local" },
      },
    },
  ])(
    "keeps a shared secret out of settings.json beside a local $placeholder across a restart",
    ({ instanceId, sharedSecretName, shared, setLocal, expected }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const id = ProviderInstanceId.make(instanceId);
        yield* writeSharedSettings({ providerInstances: { [instanceId]: shared } });
        const save = (edit: (instance: ProviderInstanceConfig) => ProviderInstanceConfig) =>
          Effect.gen(function* () {
            const forClient = ServerSettingsModule.redactServerSettingsForClient(
              yield* service.getSettings,
            );
            yield* service.updateProviderInstance({
              operation: "upsert",
              instanceId: id,
              instance: edit(forClient.providerInstances[id]!),
            });
            assert.notInclude(yield* fs.readFileString(config.settingsPath), "sk-shared");
            assert.deepEqual(yield* readStoredSecret(sharedSecretName), Option.some("sk-shared"));
          });

        yield* save(setLocal);
        yield* service.start;
        yield* save((instance) => instance);

        assert.deepEqual((yield* service.getSettings).providerInstances[id], expected);
      }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect("moves an inherited usage limit key into the store once its source is edited", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const hub = UsageLimitSourceId.make("hub");
      yield* writeSharedSettings({
        usageLimitSources: {
          hub: { kind: "cliproxy", url: "http://hub.test", managementKey: "mk-shared" },
        },
      });
      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* service.getSettings,
      );

      const updated = yield* service.updateSettings({
        usageLimitSources: { [hub]: { ...forClient.usageLimitSources[hub]!, enabled: false } },
      });

      assert.notInclude(yield* fs.readFileString(config.settingsPath), "mk-shared");
      assert.deepEqual(updated.usageLimitSources[hub], {
        kind: "cliproxy",
        url: "http://hub.test",
        managementKey: "mk-shared",
        enabled: false,
      });
      yield* service.start;
      assert.equal((yield* service.getSettings).usageLimitSources[hub]?.managementKey, "mk-shared");
    }).pipe(Effect.provide(layerSharedServerSettings())),
  );

  it.effect.each([
    ["malformed", '{"defaultAutoPull": tru'],
    ["missing", undefined],
  ] as const)(
    "keeps every local key on an unrelated save while the shared file is %s",
    ([, sharedContents]) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        if (sharedContents !== undefined) yield* writeSharedSettings(sharedContents);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ defaultAutoPull: false, worktreesDirectory: "/local/worktrees" }),
        );

        yield* service.updateSettings({ enableAgentBrowserAccess: false });

        assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
          defaultAutoPull: false,
          worktreesDirectory: "/local/worktrees",
          enableAgentBrowserAccess: false,
        });
      }).pipe(Effect.provide(layerSharedServerSettings())),
  );
});

it.layer(NodeServices.layer)("managed settings over a shared file", (it) => {
  it.effect("applies managed settings over settings.json over the shared file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        defaultAutoPull: true,
        worktreesDirectory: "/shared/worktrees",
        branchNamePrefix: "shared/",
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ worktreesDirectory: "/local/worktrees", branchNamePrefix: "local/" }),
      );
      yield* writeManagedSettings({ branchNamePrefix: "nix/" });

      const settings = yield* service.getSettings;

      assert.isTrue(settings.defaultAutoPull);
      assert.equal(settings.worktreesDirectory, "/local/worktrees");
      assert.equal(settings.branchNamePrefix, "nix/");
      assert.deepEqual(yield* service.managedSettingPaths, [["branchNamePrefix"]]);
    }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );

  it.effect("writes only the patched key and no inherited or managed secret", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const keyPath = path.join(config.baseDir, "system", "openai-key");
      yield* writeSharedSettings(SHARED_SETTINGS);
      yield* writeManagedSettings({
        branchNamePrefix: "nix/",
        providerInstances: {
          codex_work: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", value: { $file: keyPath }, sensitive: true }],
            config: { binaryPath: "/nix/store/codex/bin/codex" },
          },
        },
        sourceControlHosts: { github: { tokens: { "github.com": { $file: keyPath } } } },
      });
      yield* fs.writeFileString(keyPath, "sk-managed\n");
      const codexWork = ProviderInstanceId.make("codex_work");

      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* service.getSettings,
      );
      const updated = yield* service.updateSettings({
        enableAgentBrowserAccess: false,
        providerInstances: forClient.providerInstances,
        sourceControlHosts: forClient.sourceControlHosts,
      });

      assert.equal(updated.providerInstances[codexWork]?.environment?.[0]?.value, "sk-managed");
      assert.deepEqual(updated.sourceControlHosts.github?.tokens, { "github.com": "sk-managed" });
      assert.equal(updated.branchNamePrefix, "nix/");
      assert.isTrue(updated.defaultAutoPull);
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        enableAgentBrowserAccess: false,
      });
      assert.isTrue(
        Option.isNone(
          yield* secrets.get(
            sourceControlHostSecretName({
              kind: "github",
              field: "tokens",
              serverHost: "github.com",
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );

  it.effect("enforces a managed key that both lower layers set and persists neither", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* writeSharedSettings({
        branchNamePrefix: "shared/",
        worktreesDirectory: "/shared/worktrees",
      });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ branchNamePrefix: "local/" }),
      );
      yield* writeManagedSettings({
        branchNamePrefix: "nix/",
        worktreesDirectory: "/nix/worktrees",
      });

      const rejected = yield* Effect.flip(service.updateSettings({ branchNamePrefix: "other/" }));
      assert.equal(rejected._tag, "ManagedSettingWriteError");
      const updated = yield* service.updateSettings({ defaultAutoPull: true });

      assert.equal(updated.branchNamePrefix, "nix/");
      assert.equal(updated.worktreesDirectory, "/nix/worktrees");
      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        branchNamePrefix: "local/",
        defaultAutoPull: true,
      });

      yield* writeManagedSettings({});
      yield* service.start;
      const unmanaged = yield* service.getSettings;
      assert.equal(unmanaged.branchNamePrefix, "local/");
      assert.equal(unmanaged.worktreesDirectory, "/shared/worktrees");
    }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );

  it.effect(
    "keys a managed host token the way saves do, so writes neither persist nor leak it",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const tokenPath = `${config.baseDir}/github-token`;
        const tokenSecret = sourceControlHostSecretName({
          kind: "github",
          field: "tokens",
          serverHost: "github.com",
        });
        yield* fs.writeFileString(tokenPath, "file-token\n");
        yield* writeSharedSettings({
          sourceControlHosts: { github: { tokens: { "github.com": "ghp_shared" } } },
        });
        yield* writeManagedSettings({
          sourceControlHosts: { github: { tokens: { " GitHub.com ": { $file: tokenPath } } } },
        });

        const settings = yield* service.getSettings;
        assert.deepEqual(settings.sourceControlHosts.github?.tokens, {
          "github.com": "file-token",
        });
        assert.deepEqual(yield* service.managedSettingPaths, [
          ["sourceControlHosts", "github", "tokens", "github.com"],
        ]);

        const redacted = ServerSettingsModule.redactServerSettingsForClient(settings);
        yield* service.updateSettings({
          defaultAutoPull: true,
          sourceControlHosts: redacted.sourceControlHosts,
        });
        const replaced = yield* service.updateSettings({
          sourceControlHosts: { github: { tokens: { "github.com": "ghp_other" } } },
        });

        assert.deepEqual(replaced.sourceControlHosts.github?.tokens, {
          "github.com": "file-token",
        });
        assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
          defaultAutoPull: true,
        });
        assert.deepEqual(yield* readStoredSecret(tokenSecret), Option.none());
      }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );

  it.effect("keeps a managed key's local default while the shared file differs", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      assert.isFalse(DEFAULT_SERVER_SETTINGS.defaultAutoPull);
      yield* writeSharedSettings({ defaultAutoPull: true });
      yield* fs.writeFileString(config.settingsPath, JSON.stringify({ defaultAutoPull: false }));
      yield* writeManagedSettings({ defaultAutoPull: true });

      yield* service.updateSettings({ branchNamePrefix: "local/" });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {
        defaultAutoPull: false,
        branchNamePrefix: "local/",
      });
      yield* writeManagedSettings({});
      yield* service.start;
      assert.isFalse((yield* service.getSettings).defaultAutoPull);
    }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );

  it.effect("keeps a shared secret out of settings.json beside a local placeholder", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const keyPath = path.join(config.baseDir, "system", "github-token");
      const codexWork = ProviderInstanceId.make("codex_work");
      const githubTokenSecretName = sourceControlHostSecretName({
        kind: "github",
        field: "tokens",
        serverHost: "github.com",
      });
      yield* writeSharedSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            environment: [
              { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true },
              { name: "LOCAL_TOKEN", value: "", sensitive: true },
            ],
            config: {},
          },
        },
      });
      yield* writeManagedSettings({
        branchNamePrefix: "nix/",
        sourceControlHosts: { github: { tokens: { "github.com": { $file: keyPath } } } },
      });
      yield* fs.writeFileString(keyPath, "sk-managed\n");
      const save = (edit: (instance: ProviderInstanceConfig) => ProviderInstanceConfig) =>
        Effect.gen(function* () {
          const forClient = ServerSettingsModule.redactServerSettingsForClient(
            yield* service.getSettings,
          );
          yield* service.updateProviderInstance({
            operation: "upsert",
            instanceId: codexWork,
            instance: edit(forClient.providerInstances[codexWork]!),
          });
          const written = yield* fs.readFileString(config.settingsPath);
          assert.notInclude(written, "sk-shared");
          assert.notInclude(written, "sk-managed");
          assert.deepEqual(
            yield* readStoredSecret("provider-env-Y29kZXhfd29yaw-T1BFTkFJX0FQSV9LRVk"),
            Option.some("sk-shared"),
          );
          assert.deepEqual(yield* readStoredSecret(githubTokenSecretName), Option.none());
        });

      yield* save((instance) => ({
        ...instance,
        environment: (instance.environment ?? []).map((variable) =>
          variable.name === "LOCAL_TOKEN" ? { ...variable, value: "tok-local" } : variable,
        ),
      }));
      yield* service.start;
      yield* save((instance) => instance);

      const settings = yield* service.getSettings;
      assert.deepEqual(settings.providerInstances[codexWork]?.environment, [
        { name: "OPENAI_API_KEY", value: "sk-shared", sensitive: true, valueRedacted: true },
        { name: "LOCAL_TOKEN", value: "tok-local", sensitive: true, valueRedacted: true },
      ]);
      assert.equal(settings.branchNamePrefix, "nix/");
      assert.deepEqual(settings.sourceControlHosts.github?.tokens, { "github.com": "sk-managed" });
    }).pipe(Effect.provide(layerSharedServerSettings({ managed: true }))),
  );
});
