import { describe, expect, it } from "vite-plus/test";

import {
  assemblyEntryRemote,
  githubBranchUrl,
  githubCommitUrl,
  parseAssemblyBuild,
} from "./assemblyBuild";

const record = {
  schemaVersion: 1,
  manifest: "manifest.toml",
  commit: "675de0f84bbf866cdd2fb07202fc7263a05da7ec",
  fork: { remote: "https://github.com/colonelpanic8/t3code", branch: "t3code/assembled" },
  upstream: {
    remote: "https://github.com/pingdotgg/t3code.git",
    ref: "main",
    commit: "cefb544af3c98224874419198c0359b652ca3c94",
    subject: "feat(web): celebrate a GitHub star with confetti (#29987)",
    date: "2026-11-02T23:26:12-08:00",
    distance: 0,
    tag: "v0.1.7-nightly.20261103.4119",
  },
  entries: [
    {
      label: "t3code/main/pr-4257",
      kind: "branch",
      status: "merged",
      commit: "1bdc29f9385e26bab993efcfa8bb4458318afde1",
      branch: "t3code/main/pr-4257",
      pr: 4257,
      summary: "Directory-path Tab completion",
      parents: [{ label: "ignored", source: "fork:x", commit: "" }],
    },
    { label: "patches/glue.patch", kind: "patch", status: "merged", commit: "" },
  ],
};

describe("parseAssemblyBuild", () => {
  it("reads fork-assembler provenance, tolerating fields it does not show", () => {
    const build = parseAssemblyBuild(JSON.stringify(record));
    expect(build?.entries.map((entry) => entry.label)).toEqual([
      "t3code/main/pr-4257",
      "patches/glue.patch",
    ]);
    expect(build?.commit).toBe(record.commit);
  });

  it("is absent outside an assembly build or for an unreadable record", () => {
    expect(parseAssemblyBuild("")).toBeNull();
    expect(parseAssemblyBuild(JSON.stringify({ entries: [] }))).toBeNull();
  });
});

describe("GitHub links", () => {
  it("links carried branches and commits through the fork", () => {
    const build = parseAssemblyBuild(JSON.stringify(record))!;
    const entry = build.entries[0]!;
    const remote = assemblyEntryRemote(build, entry);
    expect(githubCommitUrl(remote, entry.commit)).toBe(
      "https://github.com/colonelpanic8/t3code/commit/1bdc29f9385e26bab993efcfa8bb4458318afde1",
    );
    expect(githubBranchUrl(remote, entry.branch!)).toBe(
      "https://github.com/colonelpanic8/t3code/tree/t3code/main/pr-4257",
    );
  });

  it("normalizes .git and SSH remotes and skips non-GitHub ones", () => {
    expect(githubCommitUrl(record.upstream.remote, "abc")).toBe(
      "https://github.com/pingdotgg/t3code/commit/abc",
    );
    expect(githubCommitUrl("git@github.com:pingdotgg/t3code.git", "abc")).toBe(
      "https://github.com/pingdotgg/t3code/commit/abc",
    );
    expect(githubCommitUrl("https://gitlab.com/a/b", "abc")).toBeNull();
  });
});
