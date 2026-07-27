import { describe, expect, it } from "vite-plus/test";

import {
  countStack,
  entryBranchUrl,
  entryCommitUrl,
  entryPullRequestUrl,
  parseStackProvenance,
  upstreamCommitUrl,
  type StackEntry,
} from "./stackProvenance.logic";

const UPSTREAM_REMOTE = "https://github.com/pingdotgg/t3code";
const FORK_REMOTE = "https://github.com/colonelpanic8/t3code";

const DOCUMENT = {
  schemaVersion: 1,
  manifest: "stack.toml",
  upstream: {
    remote: UPSTREAM_REMOTE,
    ref: "main",
    commit: "5719e8ac4020dda0e375ef61d044b61f55a0df8a",
    subject: "feat(web): show fast mode as a bolt",
    date: "2026-07-24T19:28:37-07:00",
  },
  fork: { remote: FORK_REMOTE, branch: "t3code/stack" },
  entries: [
    {
      label: "#3984",
      kind: "external",
      status: "merged",
      commit: "690d45fdd7a903911b5ea47c5dbce6469def10c6",
      pr: 3984,
      ref: "refs/pull/3984/head",
      summary: "Render generated images inline in chat",
    },
    {
      label: "t3code/group/thread-picker",
      kind: "fork",
      status: "merged",
      commit: "b15922fad031c605b31c6501097d649bc23cd83c",
      branch: "t3code/group/thread-picker",
      summary: "Thread-picker group",
      note: "  GROUP entry.  ",
      entries: [
        {
          label: "#4263",
          kind: "fork",
          status: "merged",
          commit: "ef15fa2ea50b4b6f1c6c0929e0a214301211dac6",
          pr: 4263,
          branch: "t3code/replace-ctrl-n-thread-modal",
          summary: "Unify the new thread project picker",
        },
        {
          label: "#4257",
          kind: "fork",
          status: "absorbed",
          commit: "ee5da25a75f9d414a1e3c38d00d2129d01481ad2",
          pr: 4257,
          branch: "t3code/directory-path-tab-completion",
          summary: "Directory path tab completion",
        },
      ],
    },
    {
      label: "fixture.patch",
      kind: "epilogue",
      status: "epilogue",
      commit: "",
      summary: "Add a missing test fixture field",
    },
  ],
};

function parse(document: unknown) {
  return parseStackProvenance(JSON.stringify(document));
}

describe("parseStackProvenance", () => {
  it("reads a complete document", () => {
    const provenance = parse(DOCUMENT);

    expect(provenance?.schemaVersion).toBe(1);
    expect(provenance?.upstream.commit).toBe(DOCUMENT.upstream.commit);
    expect(provenance?.fork.branch).toBe("t3code/stack");
    expect(provenance?.entries).toHaveLength(3);
  });

  it("trims notes and preserves their internal newlines", () => {
    const withNewlines = {
      ...DOCUMENT,
      entries: [{ label: "#1", note: "\n first\n\n second \n" }],
    };

    expect(parse(withNewlines)?.entries[0]?.note).toBe("first\n\n second");
  });

  it("inlines group members", () => {
    const group = parse(DOCUMENT)?.entries[1];

    expect(group?.entries.map((entry) => entry.pr)).toEqual([4263, 4257]);
  });

  it("stops nesting after one level, matching the manifests", () => {
    const nested = {
      ...DOCUMENT,
      entries: [
        {
          label: "outer",
          entries: [{ label: "inner", entries: [{ label: "deeper" }] }],
        },
      ],
    };

    expect(parse(nested)?.entries[0]?.entries[0]?.entries).toEqual([]);
  });

  it("drops entries with no label rather than failing the document", () => {
    const damaged = { ...DOCUMENT, entries: [{ kind: "fork" }, { label: "#1" }] };

    expect(parse(damaged)?.entries.map((entry) => entry.label)).toEqual(["#1"]);
  });

  it("falls back to sane defaults for an unrecognized kind or status", () => {
    const damaged = { ...DOCUMENT, entries: [{ label: "#1", kind: "wat", status: "wat" }] };
    const entry = parse(damaged)?.entries[0];

    expect(entry?.kind).toBe("fork");
    expect(entry?.status).toBe("merged");
  });

  it("ignores a non-integer pull request number", () => {
    const damaged = { ...DOCUMENT, entries: [{ label: "#1", pr: "4259" }] };

    expect(parse(damaged)?.entries[0]?.pr).toBeNull();
  });

  it.each([
    ["", "an unset build-time constant"],
    ["   ", "blank"],
    ["not json", "unparseable"],
    ["[1, 2]", "a non-object document"],
    ['{"entries": []}', "a document with no upstream base"],
    ['{"upstream": {}}', "an upstream base with no commit"],
  ])("returns null for %s (%s)", (raw) => {
    expect(parseStackProvenance(raw)).toBeNull();
  });

  it("survives a document whose entries are not an array", () => {
    expect(parse({ ...DOCUMENT, entries: "nope" })?.entries).toEqual([]);
  });
});

describe("entry links", () => {
  const provenance = parse(DOCUMENT);
  const external = provenance!.entries[0]!;
  const group = provenance!.entries[1]!;
  const epilogue = provenance!.entries[2]!;

  it("points pull requests at upstream even for a fork branch", () => {
    const member = group.entries[0]!;

    expect(entryPullRequestUrl(member, UPSTREAM_REMOTE)).toBe(
      "https://github.com/pingdotgg/t3code/pull/4263",
    );
  });

  it("points branches at the fork", () => {
    expect(entryBranchUrl(group, FORK_REMOTE)).toBe(
      "https://github.com/colonelpanic8/t3code/tree/t3code/group/thread-picker",
    );
  });

  it("resolves an external entry's commit against upstream", () => {
    expect(entryCommitUrl(external, UPSTREAM_REMOTE, FORK_REMOTE)).toBe(
      `https://github.com/pingdotgg/t3code/commit/${external.commit}`,
    );
  });

  it("resolves every other entry's commit against the fork", () => {
    expect(entryCommitUrl(group, UPSTREAM_REMOTE, FORK_REMOTE)).toBe(
      `https://github.com/colonelpanic8/t3code/commit/${group.commit}`,
    );
  });

  it("has no commit link for an epilogue, which has no commit of its own", () => {
    expect(entryCommitUrl(epilogue, UPSTREAM_REMOTE, FORK_REMOTE)).toBeNull();
  });

  it("has no pull request link for an entry without one", () => {
    expect(entryPullRequestUrl(group, UPSTREAM_REMOTE)).toBeNull();
  });

  it("links the upstream base commit", () => {
    expect(upstreamCommitUrl(provenance!.upstream)).toBe(
      `https://github.com/pingdotgg/t3code/commit/${DOCUMENT.upstream.commit}`,
    );
  });
});

describe("countStack", () => {
  it("counts group members individually but the group once", () => {
    const counts = countStack(parse(DOCUMENT)!.entries);

    // Two top-level entries plus the group's two members, with the group row
    // itself not double-counted.
    expect(counts).toEqual({
      rows: 3,
      changes: 4,
      pullRequests: 3,
      epilogues: 1,
      inert: 1,
    });
  });

  it("counts an empty stack as empty", () => {
    expect(countStack([])).toEqual({
      rows: 0,
      changes: 0,
      pullRequests: 0,
      epilogues: 0,
      inert: 0,
    });
  });

  it("does not count the same pull request twice", () => {
    const duplicated = [
      { label: "#1", pr: 1, entries: [] },
      { label: "#1", pr: 1, entries: [] },
    ] as unknown as StackEntry[];

    expect(countStack(duplicated).pullRequests).toBe(1);
  });
});
