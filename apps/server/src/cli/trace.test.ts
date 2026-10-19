import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { makeTraceSpanSummary, traceCommand } from "./trace.ts";

const MINUTE_MS = 60_000;

function span(name: string, durationMs: number, endMs: number, exitTag = "Success") {
  return JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: "span",
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: exitTag, cause: "cause" },
  });
}

function browserSpan(
  name: string,
  status: { code: string; message?: string },
  attributes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "otlp-span",
    name,
    durationMs: 1,
    endTimeUnixNano: "1000000",
    status,
    attributes,
  });
}

it("reports count, rate, percentiles, and exits per span name", () => {
  const refreshes = Array.from({ length: 10 }, (_, index) =>
    span(
      "refresh",
      index + 1,
      index * MINUTE_MS,
      index === 0 ? "Interrupted" : index === 1 ? "Failure" : "Success",
    ),
  );
  const summarizer = makeTraceSpanSummary();
  [...refreshes, span("probe", 2_500, 10 * MINUTE_MS)].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.spanCount, 11);
  assert.strictEqual(summary.minutes, 10);
  assert.deepStrictEqual(summary.spans, [
    {
      name: "refresh",
      count: 10,
      perMinute: 1,
      p50Ms: 5,
      p90Ms: 9,
      maxMs: 10,
      interrupted: 1,
      failures: 1,
    },
    {
      name: "probe",
      count: 1,
      perMinute: 0.1,
      p50Ms: 2_500,
      p90Ms: 2_500,
      maxMs: 2_500,
      interrupted: 0,
      failures: 0,
    },
  ]);
});

it("drops spans that ended before the window and counts unreadable lines", () => {
  const summarizer = makeTraceSpanSummary(MINUTE_MS);
  [
    span("old", 1, 0),
    "",
    "{not json",
    JSON.stringify({ name: "no-duration" }),
    JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
    span("recent", 4, 5 * MINUTE_MS),
  ].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.skippedLineCount, 3);
  assert.deepStrictEqual(
    summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
    [["recent", 1, undefined]],
  );
});

it("reads failures and interrupts of browser spans from their OTLP status", () => {
  const summarizer = makeTraceSpanSummary();
  [
    browserSpan("render", { code: "2", message: "boom" }),
    browserSpan("render", { code: "0" }, { "effect.fiber.interrupted": true }),
    browserSpan("render", { code: "1", message: "Interrupted" }),
    browserSpan("render", { code: "1" }),
  ].forEach(summarizer.addLine);

  const [render] = summarizer.finish().spans;
  assert.deepStrictEqual([render?.count, render?.interrupted, render?.failures], [4, 2, 1]);
});

it.effect("summary reads the trace file and its rotation count from server.json", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trace-summary-" });
    const traceDir = path.join(baseDir, "userdata", "traces");
    yield* fs.makeDirectory(traceDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(baseDir, "userdata", "server.json"),
      JSON.stringify({ traceFile: "traces/server.ndjson", traceMaxFiles: 1 }),
    );
    const tracePath = path.join(traceDir, "server.ndjson");
    yield* fs.writeFileString(tracePath, span("current", 1, 0));
    yield* fs.writeFileString(`${tracePath}.1`, span("rotated", 1, 0));
    yield* fs.writeFileString(`${tracePath}.2`, span("beyond-max-files", 1, 0));

    const output: Array<unknown> = [];
    yield* Command.runWith(traceCommand, { version: "0.0.0" })([
      "summary",
      "--base-dir",
      baseDir,
    ]).pipe(
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => {
          output.push(...args);
        },
      }),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );

    const summary = String(output.join("\n"));
    assert.match(summary, /^2 spans ended/);
    assert.include(summary, "current");
    assert.include(summary, "rotated");
    assert.notInclude(summary, "beyond-max-files");
  }).pipe(Effect.provide(NodeServices.layer)),
);
