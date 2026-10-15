import { resolveLegacyT3StorageRoots, resolveT3ConfiguredPath } from "@t3tools/shared/storagePaths";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import {
  planStorageMigration,
  rollbackStorageMigration,
  runStorageMigration,
  type StorageMigrationInput,
  type StorageMigrationPlan,
} from "../storage/storageMigration.ts";
import {
  currentStorageHost,
  deriveServerStoragePaths,
  resolveClientStorageRoots,
  resolveServerConfigFilePath,
  resolveServerLocationOverrides,
  resolveSplitStorageRoots,
  serverConfigFileFlags,
} from "./config.ts";

const MigrationEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option),
  clientDir: Config.String("T3CODE_CLIENT_DIR").pipe(Config.option),
  appData: Config.String("APPDATA").pipe(Config.option),
  xdgConfigHome: Config.String("XDG_CONFIG_HOME").pipe(Config.option),
});

const nonEmpty = (value: Option.Option<string>) =>
  Option.filter(value, (candidate) => candidate.trim().length > 0);

interface MigrationLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly clientDir: Option.Option<string>;
  readonly serverConfigDir: Option.Option<string>;
  readonly serverDataDir: Option.Option<string>;
  readonly serverConfigFile: Option.Option<string>;
}

/**
 * The legacy tree (--base-dir, then T3CODE_HOME, then ~/.t3) and where the
 * migrated app will read each of its files: the split roots, except where a
 * server location override or a client dir names another place.
 */
const resolveMigrationInput = Effect.fn("cli.storage.resolveMigrationInput")(function* (
  flags: MigrationLocationFlags,
) {
  const path = yield* Path.Path;
  const env = yield* MigrationEnvironment;
  const host = yield* currentStorageHost;
  const legacyBaseDir =
    resolveT3ConfiguredPath(
      Option.getOrUndefined(Option.orElse(nonEmpty(flags.baseDir), () => nonEmpty(env.t3Home))),
      host.homeDirectory,
      path,
    ) ?? path.join(host.homeDirectory, ".t3");
  const serverRoots = yield* resolveSplitStorageRoots({ isDevelopment: false, host });
  const serverLocationFlags = { ...flags, baseDir: Option.none<string>() };
  const overrides = yield* resolveServerLocationOverrides(serverLocationFlags);
  // Refuses an override and a selector naming different directories, as the migrated server would.
  yield* deriveServerStoragePaths(
    { roots: serverRoots, baseDirIsExplicit: false },
    undefined,
    overrides,
  );
  const configFile = yield* resolveServerConfigFilePath(
    serverLocationFlags,
    overrides.configDir ?? serverRoots.configDir,
  );
  const clientRoots = yield* resolveClientStorageRoots({
    serverRoots,
    isDevelopment: false,
    host,
  });
  // Where Electron keeps profiles by default; see DesktopUserData.resolveUserDataPath.
  const appData =
    host.platform === "win32"
      ? Option.getOrElse(nonEmpty(env.appData), () =>
          path.join(host.homeDirectory, "AppData", "Roaming"),
        )
      : host.platform === "darwin"
        ? path.join(host.homeDirectory, "Library", "Application Support")
        : Option.getOrElse(
            Option.filter(nonEmpty(env.xdgConfigHome), (value) => path.isAbsolute(value)),
            () => path.join(host.homeDirectory, ".config"),
          );
  return {
    legacyRoots: resolveLegacyT3StorageRoots({
      baseDir: legacyBaseDir,
      stateDirectoryName: "userdata",
      path,
    }),
    serverRoots,
    clientRoots,
    serverOverrides: {
      configDir: overrides.configDir,
      dataDir: overrides.dataDir,
      configFile: configFile.explicit ? configFile.path : undefined,
    },
    clientDir: resolveT3ConfiguredPath(
      Option.getOrUndefined(
        Option.orElse(nonEmpty(flags.clientDir), () => nonEmpty(env.clientDir)),
      ),
      host.homeDirectory,
      path,
    ),
    legacyElectronProfiles: [
      path.join(appData, "t3code-v2"),
      path.join(appData, "T3 Code (Alpha)"),
    ],
    // The split-layout desktop's Electron profile; see DesktopEnvironment.
    electronProfile: path.join(clientRoots.stateDir, "electron"),
  } satisfies StorageMigrationInput;
});

const formatBytes = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`;
};

const formatStorageMigrationPlan = (plan: StorageMigrationPlan): string => {
  const { clientDir, clientRoots, legacyRoots, serverOverrides, serverRoots } = plan.input;
  const overridden = (override: string | undefined, root: string) =>
    override === undefined ? root : `${override} (override)`;
  const lines = [
    `Legacy storage: ${legacyRoots.stateDir}`,
    "Server storage:",
    `  config   ${overridden(serverOverrides.configDir, serverRoots.configDir)}`,
    `  data     ${overridden(serverOverrides.dataDir, serverRoots.dataDir)}`,
    `  state    ${overridden(serverOverrides.dataDir, serverRoots.stateDir)}`,
    `  cache    ${serverRoots.cacheDir}`,
    `  runtime  ${overridden(serverOverrides.dataDir, serverRoots.runtimeDir)}`,
    "Client storage:",
    `  config   ${clientRoots.configDir}`,
    `  state    ${clientRoots.stateDir}`,
    `  cache    ${clientRoots.cacheDir}`,
    ...(clientDir === undefined ? [] : [`  files    ${clientDir} (client dir)`]),
    "",
  ];
  if (plan.migratedAt !== undefined) {
    lines.push(`Already migrated at ${plan.migratedAt}. Nothing to do.`);
    return lines.join("\n");
  }
  lines.push("Copy:");
  for (const entry of plan.entries) {
    const size =
      entry.kind === "directory"
        ? `${String(entry.files)} files, ${formatBytes(entry.bytes)}`
        : formatBytes(entry.bytes);
    const status =
      entry.status === "present"
        ? "  already present"
        : entry.status === "conflict"
          ? "  CONFLICT: destination exists with different contents"
          : "";
    const method = entry.kind === "database" ? "sqlite snapshot, " : "";
    lines.push(`  ${entry.owner.padEnd(6)} ${entry.source}`);
    lines.push(`         -> ${entry.destination} (${method}${size})${status}`);
  }
  if (plan.skipped.length > 0) {
    lines.push("", "Left in place:");
    for (const skip of plan.skipped) lines.push(`  ${skip.path}: ${skip.reason}`);
  }
  const conflicts = plan.entries.filter((entry) => entry.status === "conflict").length;
  if (plan.blockers.length > 0 || conflicts > 0) {
    lines.push("", "Before migrating:");
    for (const blocker of plan.blockers) lines.push(`  - ${blocker}`);
    if (conflicts > 0) {
      lines.push(
        `  - ${String(conflicts)} destination(s) conflict. --replace-existing moves each aside to <name>.pre-migration-<time> first.`,
      );
    }
  }
  return lines.join("\n");
};

const migrateCommand = Command.make("migrate", {
  baseDir: Flag.String("base-dir").pipe(
    Flag.withDescription("Legacy T3 home to migrate. Default: T3CODE_HOME, then ~/.t3."),
    Flag.optional,
  ),
  clientDir: Flag.String("client-dir").pipe(
    Flag.withDescription(
      "The desktop app's client dir (equivalent to T3CODE_CLIENT_DIR). The desktop files it holds stay there.",
    ),
    Flag.optional,
  ),
  serverConfigDir: serverConfigFileFlags.serverConfigDir,
  serverDataDir: serverConfigFileFlags.serverDataDir,
  serverConfigFile: serverConfigFileFlags.serverConfigFile,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show what would be copied and why it cannot run yet; write nothing."),
    Flag.withDefault(false),
  ),
  replaceExisting: Flag.Boolean("replace-existing").pipe(
    Flag.withDescription("Move conflicting destination files aside instead of refusing."),
    Flag.withDefault(false),
  ),
  rollback: Flag.Boolean("rollback").pipe(
    Flag.withDescription(
      "Return to the legacy tree: move the migrated copies aside and remove the marker.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Copy a legacy ~/.t3 installation into the split storage layout. The legacy tree is never modified except for a marker that retires it.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* resolveMigrationInput(flags);
      if (flags.rollback) {
        const { rolledBack } = yield* rollbackStorageMigration(input);
        if (rolledBack.length === 0) {
          yield* Console.log(
            `${input.legacyRoots.stateDir} is not migrated. Nothing to roll back.`,
          );
          return;
        }
        yield* Console.log(
          [
            `Rolled back. T3 Code uses ${input.legacyRoots.stateDir} again.`,
            "The migrated copies were moved aside, not deleted:",
            ...rolledBack.map((aside) => `  ${aside}`),
          ].join("\n"),
        );
        return;
      }
      if (flags.dryRun) {
        yield* Console.log(formatStorageMigrationPlan(yield* planStorageMigration(input)));
        yield* Console.log("\nDry run: nothing was written.");
        return;
      }
      const result = yield* runStorageMigration(input, {
        replaceExisting: flags.replaceExisting,
      });
      if (!result.migrated) {
        yield* Console.log(formatStorageMigrationPlan(result.plan));
        return;
      }
      yield* Console.log(
        [
          `Copied and verified ${String(result.plan.entries.length)} entries into the split layout.`,
          ...result.replaced.map((aside) => `Moved an existing destination aside: ${aside}`),
          `${input.legacyRoots.stateDir} is retired but kept; \`t3 storage migrate --rollback\` returns to it.`,
        ].join("\n"),
      );
    }),
  ),
);

export const storageCommand = Command.make("storage").pipe(
  Command.withDescription("Manage where T3 Code stores its files."),
  Command.withSubcommands([migrateCommand]),
);
