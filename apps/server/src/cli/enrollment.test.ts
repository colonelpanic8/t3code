import * as NodeServices from "@effect/platform-node/NodeServices";
import { decodeFleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeCli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";
const ENVIRONMENT_ID = "env-self";
const SELF = {
  environmentId: ENVIRONMENT_ID,
  label: "self",
  httpBaseUrl: "https://self.example.ts.net/",
  wsBaseUrl: "wss://self.example.ts.net/",
};

// The agent running these tests may itself export T3CODE_* variables.
const layerIsolatedEnv = Layer.mergeAll(
  NetService.layer,
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {},
    }),
  ),
);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(makeCli(), {
    version: "0.0.0",
  })(args).pipe(Effect.provide(layerIsolatedEnv));
const authConfigFor = (baseDir: string) =>
  resolveCliAuthConfig(
    {
      baseDir: Option.some(baseDir),
    },
    Option.none(),
  ).pipe(Effect.provide(layerIsolatedEnv));

/**
 * Writes a stand-in for `age` that records its plaintext stdin at `capture`
 * and writes an armor header to its `-o` path. Like age, a failing run exits
 * without reading stdin; a failed encryption leaves a partial file behind.
 */
const writeFakeAge = (
  directory: string,
  options: {
    readonly recipientsExit?: number;
    readonly encryptExit?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const script = `${directory}/age`;
    const capture = `${directory}/captured-plaintext`;
    yield* fileSystem.writeFileString(
      script,
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; esac
  shift
done
if [ "$out" = "/dev/null" ]; then
  [ ${options.recipientsExit ?? 0} -eq 0 ] || { echo "age: error: unknown recipient type" >&2; exit ${options.recipientsExit ?? 0}; }
  cat > /dev/null
  exit 0
fi
if [ ${options.encryptExit ?? 0} -ne 0 ]; then
  printf 'PARTIAL' > "$out"
  echo "age: error: write failed" >&2
  exit ${options.encryptExit ?? 0}
fi
cat > "${capture}"
printf -- '-----BEGIN AGE ENCRYPTED FILE-----\\n' > "$out"
`,
    );
    yield* fileSystem.chmod(script, 0o755);
    return {
      script,
      capture,
    };
  });
const setUp = (options: {
  readonly writeEnvironmentId?: boolean;
  readonly entry?: typeof SELF;
  readonly age?: Parameters<typeof writeFakeAge>[1];
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-enrollment-",
    });
    const baseDir = `${directory}/home`;
    const config = yield* authConfigFor(baseDir);
    yield* fileSystem.makeDirectory(config.stateDir, {
      recursive: true,
    });
    if (options.writeEnvironmentId ?? true) {
      yield* fileSystem.writeFileString(config.environmentIdPath, `${ENVIRONMENT_ID}\n`);
    }
    const manifest = `${directory}/fleet.json`;
    yield* fileSystem.writeFileString(
      manifest,
      JSON.stringify({
        version: 1,
        environments: [
          options.entry ?? SELF,
          {
            environmentId: "env-other",
            label: "other",
            httpBaseUrl: "https://other.example.ts.net/",
            wsBaseUrl: "wss://other.example.ts.net/",
          },
        ],
      }),
    );
    const recipients = `${directory}/recipients.txt`;
    yield* fileSystem.writeFileString(recipients, "age1recipientplaceholder\n");
    const outputDirectory = `${directory}/out`;
    const output = `${outputDirectory}/fleet.age`;
    yield* fileSystem.makeDirectory(outputDirectory);
    const age = yield* writeFakeAge(directory, options.age);
    const exportArgs = [
      "auth",
      "enrollment",
      "export",
      "--base-dir",
      baseDir,
      "--recipients-file",
      recipients,
      "--output",
      output,
      "--label",
      "phones",
      "--fleet-manifest",
      manifest,
      "--age-bin",
      age.script,
    ];
    return {
      config,
      outputDirectory,
      output,
      age,
      exportArgs,
    };
  });
const withAuth = <A, E>(
  config: ServerConfig.ServerConfig["Service"],
  run: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* run(yield* EnvironmentAuth.EnvironmentAuth);
  }).pipe(
    Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
it.layer(Layer.mergeAll(NodeServices.layer, TestConsole.layer))(
  "t3 auth enrollment export",
  (it) => {
    it.effect("publishes an enrollment that redeems on this server and replaces the old file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, outputDirectory, output, age, exportArgs } = yield* setUp({});
        yield* fileSystem.writeFileString(output, "previous export");
        yield* runCli([...exportArgs, "--json"]);
        const printed = (yield* TestConsole.logLines).join("\n");
        const summary = JSON.parse(printed) as {
          readonly id: string;
          readonly environment: {
            readonly environmentId: string;
          };
          readonly path: string;
        };
        expect(yield* fileSystem.readFileString(output)).toContain("BEGIN AGE ENCRYPTED FILE");
        expect(yield* fileSystem.readDirectory(outputDirectory)).toEqual(["fleet.age"]);
        expect(summary.environment.environmentId).toBe(ENVIRONMENT_ID);
        expect(summary.path).toBe(output);
        const plaintext = yield* fileSystem.readFile(age.capture);
        const decoded = decodeFleetEnrollment(plaintext);
        if (Result.isFailure(decoded)) {
          return yield* Effect.die(decoded.failure);
        }
        const [entry, ...others] = decoded.success.environments;
        const credential = Redacted.value(entry.credential);
        // Exactly one entry for this server, in the shape bundles concatenate.
        expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
          version: 2,
          type: "t3code.fleet-enrollment",
          environments: [
            {
              ...SELF,
              credential,
              expiresAt: DateTime.formatIso(entry.expiresAt),
            },
          ],
        });
        expect(others).toEqual([]);
        expect(printed).not.toContain(credential);
        const redeemed = yield* withAuth(config, (auth) =>
          Effect.gen(function* () {
            const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
              credential,
              undefined,
              {
                deviceType: "mobile",
                label: "Pixel",
              },
            );
            const session = yield* auth.authenticateHttpRequest({
              cookies: {},
              headers: {
                authorization: `Bearer ${token.access_token}`,
              },
            } as never);
            const links = yield* auth.listPairingLinks();
            return {
              session,
              links,
            };
          }),
        );
        expect(redeemed.session.subject).toBe(`fleet-enrollment:${summary.id}`);
        expect(redeemed.links.find((link) => link.id === summary.id)?.label).toBe("phones");
      }).pipe(Effect.scoped),
    );
    it.effect("revokes the new grant and keeps the old file when encryption fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, outputDirectory, output, exportArgs } = yield* setUp({
          age: {
            encryptExit: 1,
          },
        });
        yield* fileSystem.writeFileString(output, "previous export");
        const error = yield* Effect.flip(runCli(exportArgs));
        expect(error).toMatchObject({
          _tag: "FleetEnrollmentAgeError",
          stage: "encrypt",
          exitCode: 1,
        });
        expect(yield* fileSystem.readFileString(output)).toBe("previous export");
        expect(yield* fileSystem.readDirectory(outputDirectory)).toEqual(["fleet.age"]);
        expect(yield* withAuth(config, (auth) => auth.listPairingLinks())).toEqual([]);
      }).pipe(Effect.scoped),
    );
    it.effect("cleans up a cancelled export before publication", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, outputDirectory, output, exportArgs } = yield* setUp({});
        yield* fileSystem.writeFileString(output, "previous export");
        const readyToPublish = yield* Deferred.make<void>();
        const blockedSyncFs = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (path, options) =>
            path.endsWith(".partial")
              ? Deferred.succeed(readyToPublish, undefined).pipe(Effect.andThen(Effect.never))
              : fileSystem.open(path, options),
        });
        const exporting = yield* runCli(exportArgs).pipe(
          Effect.provideService(FileSystem.FileSystem, blockedSyncFs),
          Effect.forkScoped,
        );
        yield* Deferred.await(readyToPublish).pipe(Effect.raceFirst(Fiber.join(exporting)));
        yield* Fiber.interrupt(exporting);
        expect(yield* fileSystem.readFileString(output)).toBe("previous export");
        expect(yield* fileSystem.readDirectory(outputDirectory)).toEqual(["fleet.age"]);
        expect(yield* withAuth(config, (auth) => auth.listPairingLinks())).toEqual([]);
      }).pipe(Effect.scoped),
    );
    it.effect("keeps a published enrollment valid if cancellation arrives during rename", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, outputDirectory, output, exportArgs } = yield* setUp({});
        yield* fileSystem.writeFileString(output, "previous export");
        const renamed = yield* Deferred.make<void>();
        const finishRename = yield* Deferred.make<void>();
        const controlledFs = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            fileSystem
              .rename(from, to)
              .pipe(
                Effect.andThen(
                  to === output
                    ? Deferred.succeed(renamed, undefined).pipe(
                        Effect.andThen(Deferred.await(finishRename)),
                      )
                    : Effect.void,
                ),
              ),
        });
        const exporting = yield* runCli(exportArgs).pipe(
          Effect.provideService(FileSystem.FileSystem, controlledFs),
          Effect.forkScoped,
        );
        yield* Deferred.await(renamed).pipe(Effect.raceFirst(Fiber.join(exporting)));
        const interruption = yield* Fiber.interrupt(exporting).pipe(
          Effect.forkScoped({
            startImmediately: true,
          }),
        );
        yield* Deferred.succeed(finishRename, undefined);
        yield* Fiber.join(interruption);
        expect(yield* fileSystem.readFileString(output)).toContain("BEGIN AGE ENCRYPTED FILE");
        expect(yield* fileSystem.readDirectory(outputDirectory)).toEqual(["fleet.age"]);
        expect(yield* withAuth(config, (auth) => auth.listPairingLinks())).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
    it.effect("reports recipient rejection without exposing command output", () =>
      Effect.gen(function* () {
        const { exportArgs } = yield* setUp({
          age: {
            recipientsExit: 1,
          },
        });
        const error = yield* Effect.flip(runCli(exportArgs));
        expect(error).toMatchObject({
          _tag: "FleetEnrollmentAgeError",
          stage: "recipients",
          exitCode: 1,
        });
        expect(JSON.stringify(error)).not.toContain("unknown recipient type");
      }).pipe(Effect.scoped),
    );
    it.effect.each([
      {
        name: "age rejects the recipients",
        setup: {
          age: {
            recipientsExit: 1,
          },
        },
      },
      {
        name: "the server has no environment ID",
        setup: {
          writeEnvironmentId: false,
        },
      },
      {
        name: "the manifest has no entry for this server",
        setup: {
          entry: {
            ...SELF,
            environmentId: "env-elsewhere",
          },
        },
      },
      {
        name: "the entry URLs carry credentials",
        setup: {
          entry: {
            ...SELF,
            httpBaseUrl: "https://user@self.example.ts.net/",
          },
        },
      },
      {
        name: "the entry HTTP URL has a base path",
        setup: {
          entry: {
            ...SELF,
            httpBaseUrl: "https://self.example.ts.net/t3",
          },
        },
      },
      {
        name: "the entry WebSocket URL has a base path",
        setup: {
          entry: {
            ...SELF,
            wsBaseUrl: "wss://self.example.ts.net/t3",
          },
        },
      },
    ])("mints and writes nothing when $name", ({ setup }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, output, exportArgs } = yield* setUp(setup);
        const error = yield* Effect.flip(runCli(exportArgs));
        expect(error).toMatchObject({
          _tag: expect.stringMatching(/^FleetEnrollment(Age|Preflight)Error$/),
        });
        expect(yield* fileSystem.exists(output)).toBe(false);
        expect(yield* fileSystem.exists(config.environmentIdPath)).toBe(
          setup.writeEnvironmentId ?? true,
        );
        // Preflight runs before the auth runtime, so no database was created either.
        expect(yield* fileSystem.exists(config.dbPath)).toBe(false);
      }).pipe(Effect.scoped),
    );
    it.effect("refuses a zero lifetime before creating a credential or output", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { config, output, exportArgs } = yield* setUp({});
        const error = yield* Effect.flip(runCli([...exportArgs, "--ttl", "0s"]));
        expect(error).toMatchObject({
          _tag: "FleetEnrollmentPreflightError",
          reason: "invalid-ttl",
        });
        expect(yield* fileSystem.exists(output)).toBe(false);
        expect(yield* fileSystem.exists(config.dbPath)).toBe(false);
      }).pipe(Effect.scoped),
    );
  },
);
