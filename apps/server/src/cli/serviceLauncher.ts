import { type LauncherOptions, main as runServiceLauncher } from "../serviceLauncher.ts";

/** The flags a Windows task passes, parsed here so the launcher starts without the full CLI. */
export function parseServiceLauncherArgs(args: ReadonlyArray<string>): LauncherOptions | undefined {
  let baseDir: string | undefined;
  let logFile: string | undefined;
  let serviceUnit: string | undefined;
  let configDir: string | undefined;
  let stateDir: string | undefined;
  let cacheDir: string | undefined;
  let runtimeDir: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) return undefined;
    if (flag === "--base-dir") baseDir = value;
    else if (flag === "--log-file") logFile = value;
    else if (flag === "--service-unit") serviceUnit = value;
    else if (flag === "--config-dir") configDir = value;
    else if (flag === "--state-dir") stateDir = value;
    else if (flag === "--cache-dir") cacheDir = value;
    else if (flag === "--runtime-dir") runtimeDir = value;
    else return undefined;
  }
  if ([configDir, stateDir, cacheDir, runtimeDir].some((value) => value !== undefined)) {
    if (!baseDir || !configDir || !stateDir || !cacheDir || !runtimeDir) return undefined;
    return {
      baseDir,
      logFile,
      serviceUnit,
      storageRoots: {
        layout: "split",
        configDir,
        dataDir: baseDir,
        stateDir,
        cacheDir,
        runtimeDir,
      },
    };
  }
  return { baseDir, logFile, serviceUnit };
}

export async function runServiceLauncherCli(options?: LauncherOptions): Promise<void> {
  try {
    await runServiceLauncher(options);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}
