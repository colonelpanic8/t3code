import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a stand-in for a running remote server.
import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};
const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};
const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response("", {
        status: 200,
      }),
    ),
  ),
);
const hangingHttpClient = HttpClient.make(() => Effect.never);
const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});
function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}
const ARCHIVE = {
  archiveVersion: "1.2.3-preview.20260911.4",
} as const;
describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () =>
          SshTunnel.buildRemoteT3RunnerScript({
            archiveVersion,
          }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });
  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });
  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });
  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
        };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(ARCHIVE),
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);
          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);
          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

describe("remote launch and pairing scripts", () => {
  const windowsHost = HostProcess.Platform.defaultValue() === "win32";

  // Stands in for the t3 CLI: records each invocation, and `serve` answers the
  // readiness probe on its --port.
  const FAKE_T3 = `const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.T3_FAKE_RECORD,
  JSON.stringify({
    args,
    dataDir: process.env.T3CODE_SERVER_DATA_DIR ?? null,
    configFile: process.env.T3CODE_SERVER_CONFIG_FILE ?? null,
    selectors: ["T3CODE_HOME", "T3CODE_CONFIG_DIR", "T3CODE_DATA_DIR", "T3CODE_STATE_DIR", "T3CODE_CACHE_DIR", "T3CODE_RUNTIME_DIR"].filter((name) => process.env[name] !== undefined),
  }) + "\\n",
);
if (args[0] === "serve") {
  const port = Number(args[args.indexOf("--port") + 1]);
  http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1");
  setTimeout(() => process.exit(0), 10_000);
} else {
  process.stdout.write("{}\\n");
}
`;
  const runScript = (
    script: string,
    args: ReadonlyArray<string>,
    env: Record<string, string>,
    options: {
      readonly login?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", [...(options.login ? ["-l"] : []), "-c", script, "sh", ...args], {
          env,
          extendEnv: false,
        }),
      );
      const collect = (stream: typeof child.stderr) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        );
      const [stderr, exitCode, stdout] = yield* Effect.all(
        [collect(child.stderr), child.exitCode.pipe(Effect.map(Number)), collect(child.stdout)],
        {
          concurrency: "unbounded",
        },
      );
      return {
        stderr,
        exitCode,
        stdout,
      };
    });
  it.effect.skipIf(windowsHost)(
    "pins the server and pairing to ~/.t3 even when the remote exports server overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ssh-launch-",
        });
        const home = `${root}/home`;
        const record = `${root}/record.ndjson`;
        const fakeT3 = `${root}/fake-t3.cjs`;
        yield* fs.makeDirectory(home, {
          recursive: true,
        });
        yield* fs.writeFileString(fakeT3, FAKE_T3);
        const runner = {
          nodeScriptPath: fakeT3,
        };
        const stateKey = "location-test";
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
          T3CODE_SERVER_DATA_DIR: `${root}/elsewhere`,
          T3CODE_SERVER_CONFIG_FILE: `${root}/elsewhere/server.json`,
          T3CODE_CONFIG_DIR: `${root}/xdg/config`,
          T3CODE_DATA_DIR: `${root}/xdg/data`,
          T3CODE_STATE_DIR: `${root}/xdg/state`,
          T3CODE_CACHE_DIR: `${root}/xdg/cache`,
          T3CODE_RUNTIME_DIR: `${root}/xdg/runtime`,
        };
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`${home}/.t3/ssh-launch/${stateKey}/pid`).pipe(
            Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid.trim())))),
            Effect.ignore,
          ),
        );
        const launch = yield* runScript(SshTunnel.buildRemoteLaunchScript(runner), [stateKey], env);
        assert.equal(launch.exitCode, 0, launch.stderr);
        const pairing = yield* runScript(
          SshTunnel.buildRemotePairingScript(stateKey, runner),
          [],
          env,
        );
        assert.equal(pairing.exitCode, 0, pairing.stderr);
        const invocations = (yield* fs.readFileString(record))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                args: Array<string>;
                dataDir: string | null;
                configFile: string | null;
                selectors: Array<string>;
              },
          );
        const serve = invocations.find((entry) => entry.args[0] === "serve");
        const pair = invocations.find((entry) => entry.args[0] === "auth");
        assert.deepEqual(serve?.args.slice(-2), ["--base-dir", `${home}/.t3`]);
        assert.isNull(serve?.dataDir);
        assert.isNull(serve?.configFile);
        assert.deepEqual(serve?.selectors, []);
        assert.deepEqual(pair, {
          args: ["auth", "pairing", "create", "--base-dir", `${home}/.t3`, "--json"],
          dataDir: null,
          configFile: null,
          selectors: [],
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  const readInvocations = (fs: FileSystem.FileSystem, record: string) =>
    fs.readFileString(record).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((contents) =>
        contents
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                args: Array<string>;
                selectors: Array<string>;
              },
          ),
      ),
    );
  it.effect.skipIf(windowsHost)(
    "serves an initialized split install in place instead of pinning ~/.t3",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ssh-launch-split-",
        });
        const home = `${root}/home`;
        const record = `${root}/record.ndjson`;
        const fakeT3 = `${root}/fake-t3.cjs`;
        yield* fs.makeDirectory(`${home}/.local/state/t3code`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${home}/.local/state/t3code/statev2.sqlite`, "");
        yield* fs.writeFileString(fakeT3, FAKE_T3);
        const runner = {
          nodeScriptPath: fakeT3,
        };
        const stateKey = "split-test";
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
        };
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`${home}/.t3/ssh-launch/${stateKey}/pid`).pipe(
            Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid.trim())))),
            Effect.ignore,
          ),
        );
        const launch = yield* runScript(SshTunnel.buildRemoteLaunchScript(runner), [stateKey], env);
        assert.equal(launch.exitCode, 0, launch.stderr);
        const pairing = yield* runScript(
          SshTunnel.buildRemotePairingScript(stateKey, runner),
          [],
          env,
        );
        assert.equal(pairing.exitCode, 0, pairing.stderr);
        const invocations = yield* readInvocations(fs, record);
        const serve = invocations.find((entry) => entry.args[0] === "serve");
        assert.notInclude(serve?.args ?? [], "--base-dir");
        assert.deepEqual(invocations.find((entry) => entry.args[0] === "auth")?.args, [
          "auth",
          "pairing",
          "create",
          "--json",
        ]);
        assert.isFalse(yield* fs.exists(`${home}/.t3/userdata`));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)("reuses a split install's running service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ssh-launch-split-reuse-",
      });
      const home = `${root}/home`;
      const record = `${root}/record.ndjson`;
      const fakeT3 = `${root}/fake-t3.cjs`;
      const runtimeDir = `${root}/run/t3code`;
      yield* fs.makeDirectory(`${home}/.local/state/t3code`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${home}/.local/state/t3code/environment-id`, "env");
      yield* fs.makeDirectory(runtimeDir, {
        recursive: true,
      });
      yield* fs.writeFileString(fakeT3, FAKE_T3);
      const service = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((_request, response) => response.end("ok"));
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) => Effect.sync(() => server.close()),
      );
      const address = service.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* fs.writeFileString(
        `${runtimeDir}/server-runtime.json`,
        JSON.stringify({
          pid: process.pid,
          port,
          origin: `http://127.0.0.1:${port}`,
        }),
      );
      const launch = yield* runScript(
        SshTunnel.buildRemoteLaunchScript({
          nodeScriptPath: fakeT3,
        }),
        ["split-reuse"],
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
          XDG_RUNTIME_DIR: `${root}/run`,
        },
      );
      assert.equal(launch.exitCode, 0, launch.stderr);
      assert.deepEqual(JSON.parse(launch.stdout.trim()), {
        remotePort: port,
        serverKind: "external",
      });
      assert.isFalse(
        (yield* readInvocations(fs, record)).some((entry) => entry.args[0] === "serve"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)("serves a remote whose ~/.t3 was migrated as split", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ssh-launch-migrated-",
      });
      const home = `${root}/home`;
      const record = `${root}/record.ndjson`;
      const fakeT3 = `${root}/fake-t3.cjs`;
      yield* fs.makeDirectory(`${home}/.t3/userdata`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${home}/.t3/userdata/statev2.sqlite`, "");
      yield* fs.writeFileString(`${home}/.t3/userdata/storage-migration.json`, "{}");
      yield* fs.writeFileString(fakeT3, FAKE_T3);
      const runner = {
        nodeScriptPath: fakeT3,
      };
      const stateKey = "migrated-test";
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        T3_FAKE_RECORD: record,
      };
      yield* Effect.addFinalizer(() =>
        fs.readFileString(`${home}/.t3/ssh-launch/${stateKey}/pid`).pipe(
          Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid.trim())))),
          Effect.ignore,
        ),
      );
      const launch = yield* runScript(SshTunnel.buildRemoteLaunchScript(runner), [stateKey], env);
      assert.equal(launch.exitCode, 0, launch.stderr);
      const pairing = yield* runScript(
        SshTunnel.buildRemotePairingScript(stateKey, runner),
        [],
        env,
      );
      assert.equal(pairing.exitCode, 0, pairing.stderr);
      const invocations = yield* readInvocations(fs, record);
      const serve = invocations.find((entry) => entry.args[0] === "serve");
      assert.isDefined(serve);
      assert.notInclude(serve?.args ?? [], "--base-dir");
      const auth = invocations.find((entry) => entry.args[0] === "auth");
      assert.isDefined(auth);
      assert.notInclude(auth?.args ?? [], "--base-dir");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)(
    "keeps ~/.t3 while a migration into the split layout is unfinished",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ssh-launch-pending-",
        });
        const home = `${root}/home`;
        const record = `${root}/record.ndjson`;
        const fakeT3 = `${root}/fake-t3.cjs`;
        yield* fs.makeDirectory(`${home}/.t3/userdata`, {
          recursive: true,
        });
        yield* fs.makeDirectory(`${home}/.local/state/t3code`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${home}/.t3/userdata/statev2.sqlite`, "");
        yield* fs.writeFileString(`${home}/.t3/userdata/storage-migration.pending.json`, "{}");
        yield* fs.writeFileString(`${home}/.local/state/t3code/statev2.sqlite`, "");
        yield* fs.writeFileString(fakeT3, FAKE_T3);
        const runner = {
          nodeScriptPath: fakeT3,
        };
        const stateKey = "pending-test";
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
        };
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`${home}/.t3/ssh-launch/${stateKey}/pid`).pipe(
            Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid.trim())))),
            Effect.ignore,
          ),
        );
        const launch = yield* runScript(SshTunnel.buildRemoteLaunchScript(runner), [stateKey], env);
        assert.equal(launch.exitCode, 0, launch.stderr);
        const invocations = yield* readInvocations(fs, record);
        const serve = invocations.find((entry) => entry.args[0] === "serve");
        assert.include(serve?.args ?? [], "--base-dir");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)("reuses a split install's running service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ssh-launch-split-reuse-",
      });
      const home = `${root}/home`;
      const record = `${root}/record.ndjson`;
      const fakeT3 = `${root}/fake-t3.cjs`;
      const runtimeDir = `${root}/run/t3code`;
      yield* fs.makeDirectory(`${home}/.local/state/t3code`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${home}/.local/state/t3code/environment-id`, "env");
      yield* fs.makeDirectory(runtimeDir, {
        recursive: true,
      });
      yield* fs.writeFileString(fakeT3, FAKE_T3);
      const service = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const server = NodeHttp.createServer((_request, response) => response.end("ok"));
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
        }),
        (server) => Effect.sync(() => server.close()),
      );
      const address = service.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* fs.writeFileString(
        `${runtimeDir}/server-runtime.json`,
        JSON.stringify({
          pid: process.pid,
          port,
          origin: `http://127.0.0.1:${port}`,
        }),
      );
      const launch = yield* runScript(
        SshTunnel.buildRemoteLaunchScript({
          nodeScriptPath: fakeT3,
        }),
        ["split-reuse"],
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
          XDG_RUNTIME_DIR: `${root}/run`,
        },
      );
      assert.equal(launch.exitCode, 0, launch.stderr);
      assert.deepEqual(JSON.parse(launch.stdout.trim()), {
        remotePort: port,
        serverKind: "external",
      });
      assert.isFalse(
        (yield* readInvocations(fs, record)).some((entry) => entry.args[0] === "serve"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)(
    "pairs into the storage the launch chose, even when only ~/.profile names it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-ssh-launch-profile-",
        });
        const home = `${root}/home`;
        const record = `${root}/record.ndjson`;
        const fakeT3 = `${root}/fake-t3.cjs`;
        const stateDir = `${root}/custom-state`;
        yield* fs.makeDirectory(stateDir, {
          recursive: true,
        });
        yield* fs.writeFileString(`${stateDir}/statev2.sqlite`, "");
        yield* fs.makeDirectory(home, {
          recursive: true,
        });
        // The launch runs as a login shell; the pairing script did not, and so missed this.
        yield* fs.writeFileString(`${home}/.profile`, `export T3CODE_STATE_DIR='${stateDir}'\n`);
        yield* fs.writeFileString(fakeT3, FAKE_T3);
        const runner = {
          nodeScriptPath: fakeT3,
        };
        const stateKey = "profile-test";
        // An inherited home must not reach a server the launch serves in the split layout.
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
          T3CODE_HOME: `${root}/inherited-home`,
        };
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`${home}/.t3/ssh-launch/${stateKey}/pid`).pipe(
            Effect.flatMap((pid) => Effect.try(() => process.kill(Number(pid.trim())))),
            Effect.ignore,
          ),
        );
        const launch = yield* runScript(
          SshTunnel.buildRemoteLaunchScript(runner),
          [stateKey],
          env,
          {
            login: true,
          },
        );
        assert.equal(launch.exitCode, 0, launch.stderr);
        const pairing = yield* runScript(
          SshTunnel.buildRemotePairingScript(stateKey, runner),
          [],
          env,
        );
        assert.equal(pairing.exitCode, 0, pairing.stderr);
        const invocations = yield* readInvocations(fs, record);
        const serve = invocations.find((entry) => entry.args[0] === "serve");
        const pair = invocations.find((entry) => entry.args[0] === "auth");
        assert.notInclude(serve?.args ?? [], "--base-dir");
        assert.deepEqual(serve?.selectors, ["T3CODE_STATE_DIR"]);
        assert.deepEqual(pair?.args, ["auth", "pairing", "create", "--json"]);
        assert.deepEqual(pair?.selectors, ["T3CODE_STATE_DIR"]);
        assert.isFalse(yield* fs.exists(`${home}/.t3/userdata`));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)(
    "searches every place a split runtime file can be, ~/.t3 last",
    () =>
      Effect.gen(function* () {
        const launch = SshTunnel.buildRemoteLaunchScript({
          nodeScriptPath: "/t3.cjs",
        });
        const candidates = /\nruntime_file_candidates\(\) \{\n[\s\S]*?\n\}\n/.exec(launch)?.[0];
        assert.isDefined(candidates);
        const result = yield* runScript(
          `${candidates}T3_STORAGE=split\nDEFAULT_RUNTIME_FILE=/h/.t3/userdata/server-runtime.json\nruntime_file_candidates >&2`,
          [],
          {
            PATH: process.env.PATH ?? "",
            HOME: "/h",
            XDG_RUNTIME_DIR: "/run/x",
            TMPDIR: "/t",
          },
        );
        const uid = String(process.getuid?.() ?? 0);
        assert.deepEqual(result.stderr.trim().split("\n"), [
          "/run/x/t3code/server-runtime.json",
          "/h/Library/Application Support/t3code/runtime/server-runtime.json",
          `/run/user/${uid}/t3code/server-runtime.json`,
          `/t/t3code-${uid}/server-runtime.json`,
          "/h/.t3/userdata/server-runtime.json",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  const pairWithRecordedStorage = (storage: string, extraEnv: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ssh-pair-storage-",
      });
      const home = `${root}/home`;
      const record = `${root}/record.ndjson`;
      const fakeT3 = `${root}/fake-t3.cjs`;
      const stateKey = "recorded";
      yield* fs.makeDirectory(`${home}/.t3/ssh-launch/${stateKey}`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${home}/.t3/ssh-launch/${stateKey}/storage`, storage);
      yield* fs.writeFileString(fakeT3, FAKE_T3);
      const pairing = yield* runScript(
        SshTunnel.buildRemotePairingScript(stateKey, {
          nodeScriptPath: fakeT3,
        }),
        [],
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          T3_FAKE_RECORD: record,
          ...extraEnv,
        },
      );
      assert.equal(pairing.exitCode, 0, pairing.stderr);
      const pair = (yield* readInvocations(fs, record)).find((entry) => entry.args[0] === "auth");
      return {
        pair,
        home,
      };
    });
  it.effect.skipIf(windowsHost)("decides afresh when the recorded storage is empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ssh-pair-state-",
      });
      yield* fs.writeFileString(`${stateDir}/statev2.sqlite`, "");
      const { pair } = yield* pairWithRecordedStorage("", {
        T3CODE_STATE_DIR: stateDir,
      });
      assert.deepEqual(pair?.args, ["auth", "pairing", "create", "--json"]);
      assert.deepEqual(pair?.selectors, ["T3CODE_STATE_DIR"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)("keeps a recorded selector on a last line with no newline", () =>
    Effect.gen(function* () {
      const { pair } = yield* pairWithRecordedStorage(
        "T3_STORAGE=split\nT3CODE_STATE_DIR=/srv/t3-state",
      );
      assert.deepEqual(pair?.args, ["auth", "pairing", "create", "--json"]);
      assert.deepEqual(pair?.selectors, ["T3CODE_STATE_DIR"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.skipIf(windowsHost)("drops an inherited T3CODE_HOME when restoring ~/.t3", () =>
    Effect.gen(function* () {
      const { pair, home } = yield* pairWithRecordedStorage("T3_STORAGE=legacy\n", {
        T3CODE_HOME: "/elsewhere",
        T3CODE_STATE_DIR: "/inherited-state",
      });
      assert.deepEqual(pair?.args, [
        "auth",
        "pairing",
        "create",
        "--base-dir",
        `${home}/.t3`,
        "--json",
      ]);
      assert.deepEqual(pair?.selectors, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
