// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as Path from "effect/Path";
import { makeCli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { acquireRelayClientForLink, finishConnectLink } from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

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

/** Captures console lines from a successful local disconnect report. */

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "connect with server location overrides",
  (it) => {
    it.effect("names this command's server locations in the link next step", () =>
      Effect.gen(function* () {
        const logs: Array<string> = [];
        yield* finishConnectLink({
          command: yield* ServerConfig.deriveServerPaths("/srv/home", undefined, {
            configDir: "/srv/t3 config",
            dataDir: "/srv/t3 data",
          }),
          service: yield* ServerConfig.deriveServerPaths("/srv/home", undefined),
          publishOnly: false,
        }).pipe(
          Effect.provideService(HostProcess.Arguments, ["node", "/usr/local/bin/t3"]),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args: ReadonlyArray<unknown>) => {
              logs.push(args.map(String).join(" "));
            },
          }),
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
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-connect-locations-",
        });
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
          Command.runWith(
            makeCli({
              cloudEnabled: true,
            }),
            {
              version: "0.0.0",
            },
          )(args).pipe(
            Effect.provideService(Console.Console, {
              ...globalThis.console,
              log: () => {},
            }),
          );
        yield* runCli(["connect", "status", "--json", ...locationArgs]);
        yield* runCli(["connect", "logout", ...locationArgs]);
        assert.isFalse(yield* fs.exists(home));
        assert.isTrue(yield* fs.exists(path.join(root, "data")));
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect unlink",
  (it) => {
    const runUnlink = (recordedPid: number, options?: { readonly portFreed?: boolean }) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return { requests, warnings, printed: (yield* TestConsole.logLines).join("\n") };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(printed, "T3 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runUnlink(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runUnlink(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "T3 Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);
