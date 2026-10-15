import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { triageCommand } from "./triage.ts";

const triageContextFor = Effect.fn(function* (serverJson: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" });
  const configFile = path.join(baseDir, "userdata", "server.json");
  yield* fs.makeDirectory(path.dirname(configFile), { recursive: true });
  yield* fs.writeFileString(configFile, JSON.stringify(serverJson));

  yield* Command.runWith(triageCommand, { version: "0.0.0" })(["--base-dir", baseDir]).pipe(
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(Console.Console, { ...globalThis.console, log: () => {} }),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );

  const runs = yield* fs.readDirectory(path.join(baseDir, "userdata", "triage"));
  assert.lengthOf(runs, 1);
  const context = yield* fs.readFileString(
    path.join(baseDir, "userdata", "triage", runs[0]!, "context.md"),
  );
  return { baseDir, configFile, context };
});

it.effect("reports a malformed server.json and still writes the context", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { baseDir, configFile, context } = yield* triageContextFor({ mode: "daemon" });

    assert.include(
      context,
      [
        `- Server config file (optional; the server reads it at startup): ${configFile} (invalid, so the server will not start):`,
        "  ```",
        "  Invalid value",
        '    at ["mode"]',
        "  mode must be one of: web, desktop",
        "  ```",
        "- Logs dir: ",
      ].join("\n"),
    );
    assert.include(
      context,
      `- Server trace (ndjson): ${path.join(baseDir, "userdata", "logs", "server.trace.ndjson")}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("names the server.json keys the server ignores", () =>
  Effect.gen(function* () {
    const { configFile, context } = yield* triageContextFor({
      logLevel: "Info",
      serverDataDir: "/elsewhere",
      futureOption: true,
    });

    assert.include(
      context,
      `- Server config file (optional; the server reads it at startup): ${configFile} (ignored unknown keys: serverDataDir, futureOption)\n`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("points at the split layout's service and desktop logs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-split-" });
    const env = {
      ...Object.fromEntries(
        ["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((name) => [
          `T3CODE_${name}_DIR`,
          path.join(root, name.toLowerCase()),
        ]),
      ),
      T3CODE_CLIENT_STATE_DIR: path.join(root, "client-state"),
    };

    yield* Command.runWith(triageCommand, { version: "0.0.0" })([]).pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(Console.Console, { ...globalThis.console, log: () => {} }),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );

    const triageDir = path.join(root, "state", "triage");
    const [run] = yield* fs.readDirectory(triageDir);
    const context = yield* fs.readFileString(path.join(triageDir, run!, "context.md"));
    const logsDir = path.join(root, "state", "logs");
    assert.include(
      context,
      `- Service log (systemd/launchd service installs only): ${path.join(logsDir, "boot-service.log")}\n`,
    );
    assert.include(
      context,
      `written only when a backend crashes or fails to start): ${path.join(root, "client-state", "logs", "server-child*.log*")}\n`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
