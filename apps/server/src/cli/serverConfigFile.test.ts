// @effect-diagnostics nodeBuiltinImport:off - these tests run the real CLI in a child process and read its stdout.
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
const binPath = NodePath.join(import.meta.dirname, "..", "bin.ts");
const unknownKeyWarning = /ignoring unknown keys in the server config file[\s\S]*'futureOption'/;
const withHome = async (run: (root: string, home: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-server-json-cli-"));
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), {
    recursive: true
  });
  await NodeFSP.writeFile(NodePath.join(home, "userdata", "server.json"), JSON.stringify({
    logLevel: "Info",
    futureOption: true
  }));
  try {
    await run(root, home);
  } finally {
    await NodeFSP.rm(root, {
      recursive: true,
      force: true
    });
  }
};

// None of the invoking shell's T3CODE_*, OTEL_*, or provider setup leaks in.
const cliEnv = (root: string, home: string) => ({
  HOME: root,
  PATH: NodePath.dirname(process.execPath),
  T3CODE_HOME: home,
  T3CODE_TELEMETRY_ENABLED: "false"
});
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = NodeNet.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")));
  });
});
it("keeps `auth pairing create --json` stdout a single JSON document", async () => {
  await withHome(async (root, home) => {
    const result = NodeChildProcess.spawnSync(process.execPath, [binPath, "auth", "pairing", "create", "--json", "--base-dir", home], {
      cwd: root,
      env: cliEnv(root, home),
      encoding: "utf8",
      timeout: 60_000
    });
    assert.equal(result.status, 0, result.stderr);
    const pairing = JSON.parse(result.stdout) as {
      readonly credential?: unknown;
    };
    assert.isString(pairing.credential);
    assert.notMatch(result.stderr, unknownKeyWarning);
  });
});
it("warns about unknown keys in the server log when `serve` starts", async () => {
  await withHome(async (root, home) => {
    const port = await freePort();
    const child = NodeChildProcess.spawn(process.execPath, [binPath, "serve", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root,
      env: cliEnv(root, home),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        let output = "";
        // Rejects well inside the test timeout so the finally below always stops serve.
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- This deadline only rejects; stdout drives success.
        const timeout = setTimeout(() => reject(new Error(`no warning within 45s:\n${output}`)), 45_000);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (unknownKeyWarning.test(output)) {
            clearTimeout(timeout);
            resolve(output);
          }
        });
        void exited.then(() => {
          clearTimeout(timeout);
          reject(new Error(`serve exited before warning:\n${output}`));
        });
      });
      assert.match(stdout, unknownKeyWarning);
    } finally {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(forceKill);
    }
  });
});
