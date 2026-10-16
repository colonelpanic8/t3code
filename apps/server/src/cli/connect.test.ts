import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Terminal from "effect/Terminal";
import { Command } from "effect/cli";

import { makeCli } from "../binCli.ts";
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import {
  acquireRelayClientForLink,
  finishConnectLink,
  finishConnectSetup,
  headlessSessionConfig,
  reportCloudDisconnectResults,
} from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";

const readHeadlessSessionConfig = (env: Record<string, string>) =>
  headlessSessionConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("detects headless operation from individual SSH config values", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* readHeadlessSessionConfig({}));
    assert.isFalse(yield* readHeadlessSessionConfig({ CI: "true" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_CONNECTION: "client server" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_TTY: "/dev/pts/1" }));
  }),
);

it.effect("treats cancelling optional background setup as a successful skip", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(Effect.fail(new Terminal.QuitError({})));
    assert.isFalse(result);
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.isFalse(result);
  }),
);

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.effect("installs the relay client after the user accepts the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const progress: Array<string> = [];
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: (report) =>
          report({ type: "progress", stage: "downloading" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                installCalls += 1;
                return managedExecutable;
              }),
            ),
          ),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(true),
      (event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(installCalls, 1);
    assert.deepEqual(progress, ["downloading"]);
  }),
);

it.effect("reuses an available relay client executable without prompting", () =>
  Effect.gen(function* () {
    let promptCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed(managedExecutable),
        install: Effect.die("unexpected install"),
        installWithProgress: () => Effect.die("unexpected install"),
        pruneManagedVersions: Effect.void,
      },
      () =>
        Effect.sync(() => {
          promptCalls += 1;
          return false;
        }),
      () => Effect.void,
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(promptCalls, 0);
  }),
);

it.effect("keeps disconnect causes in structured logs and out of console warnings", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;
  const logger = Logger.make(({ fiber }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const liveFailure = "live unlink private diagnostic";
  const relayFailure = "relay revoke private diagnostic";

  return reportCloudDisconnectResults({
    clearAuthorization: true,
    liveResult: {
      status: "failed",
      cause: Cause.fail(new Error(liveFailure)),
    },
    relayResult: Exit.failCause(Cause.die(new Error(relayFailure))),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.lengthOf(warnings, 2);
        const warningText = warnings.flat().map(String).join("\n");
        assert.include(warningText, "running server could not stop its tunnel");
        assert.include(warningText, "Could not revoke the relay-side environment record");
        assert.notInclude(warningText, liveFailure);
        assert.notInclude(warningText, relayFailure);
        assert.deepEqual(
          logs.map(({ operation, clearAuthorization }) => ({ operation, clearAuthorization })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            { operation: "relay-environment-unlink", clearAuthorization: true },
          ],
        );
        const loggedCauses = logs.map((log) => String(log.cause)).join("\n");
        assert.include(loggedCauses, liveFailure);
        assert.include(loggedCauses, relayFailure);
      }),
    ),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))(
  "connect with server location overrides",
  (it) => {
    const runHarness = Effect.fn(function* (
      overrides: ServerConfig.ServerLocationOverrides,
      finish: (
        locations: Parameters<typeof finishConnectSetup>[0],
      ) => ReturnType<typeof finishConnectSetup>,
    ) {
      const logs: Array<string> = [];
      let statusCalls = 0;
      const service = BootService.BootService.of({
        install: () => Effect.die("unexpected service install"),
        restart: Effect.die("unexpected service restart"),
        withStopped: () => Effect.die("unexpected service pause"),
        uninstall: Effect.die("unexpected service uninstall"),
        status: Effect.sync(() => {
          statusCalls += 1;
          return { supported: false, installed: false, current: false, unitPath: "", logPath: "" };
        }),
      });
      yield* finish({
        command: yield* ServerConfig.deriveServerPaths("/srv/home", undefined, overrides),
        service: yield* ServerConfig.deriveServerPaths("/srv/home", undefined),
      }).pipe(
        Effect.provideService(BootService.BootService, service),
        Effect.provideService(HostProcess.Arguments, ["node", "/usr/local/bin/t3"]),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            logs.push(args.map(String).join(" "));
          },
        }),
      );
      return { logs, statusCalls };
    });
    const setupHarness = (overrides: ServerConfig.ServerLocationOverrides) =>
      runHarness(overrides, finishConnectSetup);

    it.effect("skips the background service when connect runs with other server locations", () =>
      Effect.gen(function* () {
        const { logs, statusCalls } = yield* setupHarness({ dataDir: "/srv/t3 data" });

        assert.equal(statusCalls, 0);
        assert.deepEqual(logs, [
          "\nSkipping background setup: the background service would not use this command's server locations.\n\nNext\n  Start the server with `t3 serve --server-data-dir '/srv/t3 data'` to make this machine reachable.",
        ]);
      }),
    );

    it.effect("offers the background service when the locations match the service", () =>
      Effect.gen(function* () {
        const { logs, statusCalls } = yield* setupHarness({});

        assert.equal(statusCalls, 1);
        assert.deepEqual(logs, [
          "\nNext\n  Start the server with `t3 serve` to make this machine reachable.",
        ]);
      }),
    );

    it.effect("names this command's server locations in the link next step", () =>
      Effect.gen(function* () {
        const { logs } = yield* runHarness(
          { configDir: "/srv/t3 config", dataDir: "/srv/t3 data" },
          (locations) => finishConnectLink({ ...locations, publishOnly: false }),
        );

        assert.deepEqual(logs, [
          "\nNext\n  Start the server with `t3 serve --server-config-dir '/srv/t3 config' --server-data-dir '/srv/t3 data'` to make this machine reachable.",
        ]);
      }),
    );

    it.effect("reads status and signs out without creating anything under the T3 home", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-locations-" });
        const home = path.join(root, "home");
        const locationArgs = [
          "--base-dir",
          home,
          "--server-config-dir",
          path.join(root, "config"),
          "--server-data-dir",
          path.join(root, "data"),
          "--server-cache-dir",
          path.join(root, "cache"),
        ];
        const runCli = (args: ReadonlyArray<string>) =>
          Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })(args).pipe(
            Effect.provideService(Console.Console, { ...globalThis.console, log: () => {} }),
          );

        yield* runCli(["connect", "status", "--json", ...locationArgs]);
        yield* runCli(["connect", "logout", ...locationArgs]);

        assert.isFalse(yield* fs.exists(home));
        assert.isTrue(yield* fs.exists(path.join(root, "data")));
      }),
    );
  },
);
