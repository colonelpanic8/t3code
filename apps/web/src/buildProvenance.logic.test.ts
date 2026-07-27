import { describe, expect, it } from "vite-plus/test";

import {
  formatCommitDate,
  formatRepoLabel,
  gitHubCommitUrl,
  gitHubRepoUrl,
  parseGitHubRemote,
  shortCommit,
} from "./buildProvenance.logic";

const COMMIT = "d596d17d63421081833b0fe852993a6b1fe617a0";

describe("parseGitHubRemote", () => {
  it.each([
    ["https://github.com/colonelpanic8/t3code.git", "colonelpanic8", "t3code"],
    ["https://github.com/colonelpanic8/t3code", "colonelpanic8", "t3code"],
    ["http://github.com/pingdotgg/t3code/", "pingdotgg", "t3code"],
    ["https://x-access-token:abc@github.com/pingdotgg/t3code.git", "pingdotgg", "t3code"],
    ["git@github.com:colonelpanic8/t3code.git", "colonelpanic8", "t3code"],
    ["ssh://git@github.com/colonelpanic8/t3code", "colonelpanic8", "t3code"],
    ["  https://github.com/pingdotgg/t3code.git\n", "pingdotgg", "t3code"],
  ])("parses %s", (remote, owner, repo) => {
    expect(parseGitHubRemote(remote)).toEqual({ owner, repo });
  });

  it.each([
    ["", "an empty remote"],
    ["https://gitlab.com/owner/repo.git", "a non-GitHub host"],
    ["https://github.com/owner", "a remote with no repository segment"],
    ["not a url", "unparseable text"],
  ])("rejects %s (%s)", (remote) => {
    expect(parseGitHubRemote(remote)).toBeNull();
  });

  it("keeps a repository name that itself ends in .git", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo.git.git")).toEqual({
      owner: "owner",
      repo: "repo.git",
    });
  });
});

describe("gitHubRepoUrl", () => {
  it("normalizes every remote form to the browsable https URL", () => {
    expect(gitHubRepoUrl("git@github.com:colonelpanic8/t3code.git")).toBe(
      "https://github.com/colonelpanic8/t3code",
    );
  });

  it("returns null for an unrecognized remote", () => {
    expect(gitHubRepoUrl("https://example.com/owner/repo")).toBeNull();
  });
});

describe("gitHubCommitUrl", () => {
  it("builds a commit permalink", () => {
    expect(gitHubCommitUrl("https://github.com/colonelpanic8/t3code.git", COMMIT)).toBe(
      `https://github.com/colonelpanic8/t3code/commit/${COMMIT}`,
    );
  });

  it("accepts an abbreviated commit", () => {
    expect(gitHubCommitUrl("https://github.com/colonelpanic8/t3code", "d596d17")).toBe(
      "https://github.com/colonelpanic8/t3code/commit/d596d17",
    );
  });

  it.each([
    ["", "no commit"],
    ["   ", "blank"],
    ["not-a-sha", "non-hex"],
    ["abc", "too short to be unambiguous"],
  ])("returns null for %s (%s)", (commit) => {
    expect(gitHubCommitUrl("https://github.com/colonelpanic8/t3code", commit)).toBeNull();
  });

  it("returns null when the remote is unrecognized", () => {
    expect(gitHubCommitUrl("", COMMIT)).toBeNull();
  });
});

describe("shortCommit", () => {
  it("abbreviates to twelve characters", () => {
    expect(shortCommit(COMMIT)).toBe("d596d17d6342");
  });

  it("leaves an already-short commit alone", () => {
    expect(shortCommit(" d596d17 ")).toBe("d596d17");
  });

  it("returns an empty string when there is no commit", () => {
    expect(shortCommit("")).toBe("");
  });
});

describe("formatCommitDate", () => {
  it("renders a real commit date", () => {
    // Locale-dependent formatting, so assert the parts that do not vary.
    expect(formatCommitDate("2026-07-25T22:46:58-07:00")).toContain("2026");
  });

  it.each([
    ["", "no date"],
    ["   ", "blank"],
    ["not a date", "unparseable"],
  ])("returns null for %s (%s)", (isoDate) => {
    expect(formatCommitDate(isoDate)).toBeNull();
  });
});

describe("formatRepoLabel", () => {
  it("renders owner/repo", () => {
    expect(formatRepoLabel("git@github.com:colonelpanic8/t3code.git")).toBe("colonelpanic8/t3code");
  });

  it("returns null for an unrecognized remote", () => {
    expect(formatRepoLabel("")).toBeNull();
  });
});
