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

it.effect("reports a malformed server.json and still writes the context", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-triage-" });
    const configFile = path.join(baseDir, "userdata", "server.json");
    yield* fs.makeDirectory(path.dirname(configFile), { recursive: true });
    yield* fs.writeFileString(configFile, JSON.stringify({ mode: "daemon" }));

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
