import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createKnownEnvironment } from "./knownEnvironment.ts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "./scoped.ts";

describe("known environment bootstrap helpers", () => {
  it("creates known environments from explicit server base urls", () => {
    expect(
      createKnownEnvironment({
        label: "Remote environment",
        target: {
          httpBaseUrl: "https://remote.example.com",
          wsBaseUrl: "wss://remote.example.com",
        },
      }),
    ).toEqual({
      id: "ws:Remote environment",
      label: "Remote environment",
      source: "manual",
      target: {
        httpBaseUrl: "https://remote.example.com",
        wsBaseUrl: "wss://remote.example.com",
      },
    });
  });
});

describe("scoped refs", () => {
  const environmentId = EnvironmentId.make("environment-test");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

  it("builds stable scoped project and thread keys", () => {
    expect(scopedProjectKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedThreadKey(threadRef)).toBe("environment-test:thread-1");
  });

  it("parses scoped project and thread keys back into refs", () => {
    expect(parseScopedProjectKey("environment-test:project-1")).toEqual(projectRef);
    expect(parseScopedThreadKey("environment-test:thread-1")).toEqual(threadRef);
    expect(parseScopedProjectKey("bad-key")).toBeNull();
    expect(parseScopedThreadKey("bad-key")).toBeNull();
    for (const key of ['["host"]', '["host", ""]', '["", "thread"]', "[invalid"]) {
      expect(parseScopedProjectKey(key)).toBeNull();
      expect(parseScopedThreadKey(key)).toBeNull();
    }
  });

  it.each(["fleet:jimi-hendnix", "remote:one:two", "percent%3Ahost", "[remote]"])(
    "preserves environment %s when a scoped reference is serialized",
    (id) => {
      const environmentId = EnvironmentId.make(id);
      const project = scopeProjectRef(environmentId, ProjectId.make("project:1"));
      const thread = scopeThreadRef(environmentId, ThreadId.make("thread:delegated-task:1"));
      expect(parseScopedProjectKey(scopedProjectKey(project))).toEqual(project);
      expect(parseScopedThreadKey(scopedThreadKey(thread))).toEqual(thread);
    },
  );

  it("distinguishes an environment separator from a separator inside a thread id", () => {
    const fleet = scopeThreadRef(
      EnvironmentId.make("fleet:jimi-hendnix"),
      ThreadId.make("thread-1"),
    );
    const other = scopeThreadRef(
      EnvironmentId.make("fleet"),
      ThreadId.make("jimi-hendnix:thread-1"),
    );
    expect(scopedThreadKey(fleet)).not.toBe(scopedThreadKey(other));
    expect(parseScopedThreadKey(scopedThreadKey(fleet))).toEqual(fleet);
    expect(parseScopedThreadKey(scopedThreadKey(other))).toEqual(other);
  });
});
