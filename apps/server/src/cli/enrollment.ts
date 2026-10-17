import { ServerFleetEnvironment } from "@t3tools/contracts";
import { encodeFleetEnrollment, isPlainFleetOriginPair } from "@t3tools/shared/fleetEnrollment";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerConfig from "../config.ts";
import { authLocationFlags, DurationFromString, resolveCliAuthConfig } from "./config.ts";

const DEFAULT_ENROLLMENT_TTL = Duration.days(365);

class FleetEnrollmentPreflightError extends Schema.TaggedError<FleetEnrollmentPreflightError>()(
  "FleetEnrollmentPreflightError",
  {
    reason: Schema.Literals([
      "environment-id-missing",
      "manifest-unconfigured",
      "manifest-unreadable",
      "entry-missing",
      "entry-not-origin",
      "invalid-ttl",
    ]),
    path: Schema.optional(Schema.String),
    environmentId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "environment-id-missing":
        return `This server has no environment ID at '${this.path}'. Start it once before exporting.`;
      case "manifest-unconfigured":
        return "No fleet manifest: pass --fleet-manifest or set T3CODE_FLEET_MANIFEST_FILE.";
      case "manifest-unreadable":
        return `Could not read a valid fleet manifest at '${this.path}'.`;
      case "entry-missing":
        return `The fleet manifest has no entry for this server's environment '${this.environmentId}'.`;
      case "entry-not-origin":
        return `The fleet manifest entry for '${this.environmentId}' needs matching plain http(s)/ws(s) URLs at the server origin, without a base path.`;
      case "invalid-ttl":
        return "The fleet enrollment lifetime must be positive and finite.";
    }
  }
}

class FleetEnrollmentAgeError extends Schema.TaggedError<FleetEnrollmentAgeError>()(
  "FleetEnrollmentAgeError",
  {
    stage: Schema.Literals(["recipients", "encrypt"]),
    exitCode: Schema.NullOr(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const action =
      this.stage === "recipients" ? "rejected the recipients file" : "failed to encrypt";
    const status = this.exitCode === null ? "could not run" : `exit ${this.exitCode}`;
    return `age ${action} (${status}). Check the recipients file, executable, and output directory.`;
  }
}

class FleetEnrollmentOutputError extends Schema.TaggedError<FleetEnrollmentOutputError>()(
  "FleetEnrollmentOutputError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to publish the encrypted enrollment at '${this.path}'.`;
  }
}

/** The operator's non-secret list of fleet environments; export reads only this server's entry. */
const FleetManifestDocument = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(ServerFleetEnvironment),
});
const decodeFleetManifest = Schema.decodeEffect(fromLenientJson(FleetManifestDocument));

// age exits before reading stdin when it rejects its arguments, so a failed
// stdin write only matters when age otherwise reports success.
const runAge = Effect.fn("runAge")(function* (input: {
  readonly ageBin: string;
  readonly stage: FleetEnrollmentAgeError["stage"];
  readonly args: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (cause: unknown) =>
    new FleetEnrollmentAgeError({ stage: input.stage, exitCode: null, cause });
  const [written, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(input.ageBin, input.args));
      const [, , written] = yield* Effect.all(
        [
          Stream.runDrain(child.stderr),
          Stream.runDrain(child.stdout),
          Stream.run(Stream.make(input.stdin), child.stdin).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      return [written, yield* child.exitCode] as const;
    }),
  ).pipe(Effect.mapError(failed));
  if (exitCode !== 0) {
    return yield* new FleetEnrollmentAgeError({
      stage: input.stage,
      exitCode,
    });
  }
  if (Result.isFailure(written)) {
    return yield* failed(written.failure);
  }
});

/** Everything an export needs, checked before anything is minted or written. */
interface FleetEnrollmentExportPlan {
  readonly environment: ServerFleetEnvironment;
  readonly recipientsFile: string;
  readonly ageBin: string;
}

/**
 * Reads this server's identity without initializing it, finds its own fleet
 * entry, and has age accept the recipients. Writes nothing.
 */
const planFleetEnrollmentExport = Effect.fn("planFleetEnrollmentExport")(function* (input: {
  readonly recipientsFile: string;
  readonly fleetManifestPath: string | undefined;
  readonly ageBin: string;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  const environmentId =
    config.environmentIdOverride ??
    (yield* fileSystem.readFileString(config.environmentIdPath).pipe(
      Effect.map((raw) => raw.trim()),
      Effect.orElseSucceed(() => ""),
    ));
  if (environmentId === "") {
    return yield* new FleetEnrollmentPreflightError({
      reason: "environment-id-missing",
      path: config.environmentIdPath,
    });
  }

  const manifestPath = input.fleetManifestPath ?? config.fleetManifestPath;
  if (manifestPath === undefined) {
    return yield* new FleetEnrollmentPreflightError({ reason: "manifest-unconfigured" });
  }
  const manifest = yield* fileSystem.readFileString(manifestPath).pipe(
    Effect.flatMap(decodeFleetManifest),
    Effect.mapError(
      (cause) =>
        new FleetEnrollmentPreflightError({
          reason: "manifest-unreadable",
          path: manifestPath,
          cause,
        }),
    ),
  );
  const environment = manifest.environments.find((entry) => entry.environmentId === environmentId);
  if (environment === undefined) {
    return yield* new FleetEnrollmentPreflightError({ reason: "entry-missing", environmentId });
  }
  if (!isPlainFleetOriginPair(environment)) {
    return yield* new FleetEnrollmentPreflightError({ reason: "entry-not-origin", environmentId });
  }

  yield* runAge({
    ageBin: input.ageBin,
    stage: "recipients",
    args: ["-e", "-R", input.recipientsFile, "-o", "/dev/null"],
    stdin: new Uint8Array(),
  });

  return {
    environment,
    recipientsFile: input.recipientsFile,
    ageBin: input.ageBin,
  } satisfies FleetEnrollmentExportPlan;
});

/**
 * Mints a reusable enrollment and publishes it age-encrypted at `output` as a
 * one-entry fleet enrollment, the unit bundles are concatenated from. The
 * plaintext only reaches age's stdin. Any failure after minting revokes the
 * new grant and removes the partial ciphertext; an existing `output` is
 * replaced only by a complete file.
 */
const writeFleetEnrollmentExport = Effect.fn("writeFleetEnrollmentExport")(function* (
  plan: FleetEnrollmentExportPlan,
  input: { readonly output: string; readonly label: string; readonly ttl: Duration.Duration },
) {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const outputPath = path.resolve(input.output);
  const suffix = Hex.encode(yield* crypto.randomBytes(6));
  const partialPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${suffix}.partial`,
  );

  let published = false;

  const publish = (enrollment: PairingGrantStore.IssuedFleetEnrollment) =>
    Effect.gen(function* () {
      const plaintext = encodeFleetEnrollment({
        environments: [
          {
            environment: plan.environment,
            credential: enrollment.credential,
            expiresAt: enrollment.expiresAt,
          },
        ],
      });
      if (Result.isFailure(plaintext)) {
        return yield* plaintext.failure;
      }
      yield* runAge({
        ageBin: plan.ageBin,
        stage: "encrypt",
        args: ["-e", "-a", "-R", plan.recipientsFile, "-o", partialPath],
        stdin: plaintext.success,
      });
      yield* Effect.scoped(
        fileSystem.open(partialPath, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)),
      ).pipe(
        Effect.mapError((cause) => new FleetEnrollmentOutputError({ path: outputPath, cause })),
      );
      yield* fileSystem.rename(partialPath, outputPath).pipe(
        Effect.mapError((cause) => new FleetEnrollmentOutputError({ path: outputPath, cause })),
        Effect.tap(() =>
          Effect.sync(() => {
            published = true;
          }),
        ),
        Effect.uninterruptible,
      );
    });

  const discard = (id: string) =>
    fileSystem.remove(partialPath, { force: true }).pipe(
      Effect.ignore,
      Effect.andThen(environmentAuth.revokePairingLink(id)),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((revoked) =>
        revoked ? Effect.void : Console.error(`revoke manually: t3 auth pairing revoke ${id}`),
      ),
    );

  const issued = yield* Effect.acquireUseRelease(
    environmentAuth.createFleetEnrollment({ ttl: input.ttl, label: input.label }),
    (enrollment) => publish(enrollment).pipe(Effect.as(enrollment)),
    (enrollment) => (published ? Effect.void : discard(enrollment.id)),
  );

  return {
    id: issued.id,
    label: input.label,
    expiresAt: issued.expiresAt,
    environment: plan.environment,
    path: outputPath,
  };
});

type FleetEnrollmentExportResult = Effect.Success<ReturnType<typeof writeFleetEnrollmentExport>>;

const formatExport = (result: FleetEnrollmentExportResult, json: boolean) =>
  json
    ? `${JSON.stringify({
        id: result.id,
        label: result.label,
        expiresAt: DateTime.formatIso(result.expiresAt),
        environment: {
          environmentId: result.environment.environmentId,
          label: result.environment.label,
        },
        path: result.path,
      })}`
    : [
        `Exported fleet enrollment ${result.id} (${result.label}).`,
        `  machine: ${result.environment.label} (${result.environment.environmentId})`,
        `  expires: ${DateTime.formatIso(result.expiresAt)}`,
        `  file: ${result.path}`,
        `Revoke with: t3 auth pairing revoke ${result.id}`,
        "",
      ].join("\n");

const exportCommand = Command.make("export", {
  ...authLocationFlags,
  recipientsFile: Flag.String("recipients-file").pipe(
    Flag.withDescription("age recipients file (age1… and SSH public keys) to encrypt to."),
  ),
  output: Flag.String("output").pipe(
    Flag.withDescription("Path of the armored age file to write."),
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription("Human-readable label shown in the pairing list."),
  ),
  fleetManifest: Flag.String("fleet-manifest").pipe(
    Flag.withDescription(
      "Fleet manifest naming this server. Defaults to T3CODE_FLEET_MANIFEST_FILE.",
    ),
    Flag.optional,
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("How long new devices can enroll, for example `90d`. Defaults to 365d."),
    Flag.optional,
  ),
  ageBin: Flag.String("age-bin").pipe(
    Flag.withDescription("age executable."),
    Flag.withDefault("age"),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Write a reusable, age-encrypted fleet enrollment that phones import to pair with this server.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const ttl = Option.getOrElse(flags.ttl, () => DEFAULT_ENROLLMENT_TTL);
      if (!Duration.isPositive(ttl) || !Duration.isFinite(ttl)) {
        return yield* new FleetEnrollmentPreflightError({ reason: "invalid-ttl" });
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const layerBase = Layer.mergeAll(
        ServerConfig.layer(config),
        Layer.succeed(References.MinimumLogLevel, flags.json ? "Error" : config.logLevel),
      );
      const plan = yield* planFleetEnrollmentExport({
        recipientsFile: flags.recipientsFile,
        fleetManifestPath: Option.getOrUndefined(flags.fleetManifest),
        ageBin: flags.ageBin,
      }).pipe(Effect.provide(layerBase));
      // The auth runtime initializes state, so it is built only after the plan passes.
      const exported = yield* writeFleetEnrollmentExport(plan, {
        output: flags.output,
        label: flags.label,
        ttl,
      }).pipe(Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provideMerge(layerBase))));
      yield* Console.log(formatExport(exported, flags.json));
    }),
  ),
);

export const enrollmentCommand = Command.make("enrollment").pipe(
  Command.withDescription("Manage reusable fleet enrollments."),
  Command.withSubcommands([exportCommand]),
);
