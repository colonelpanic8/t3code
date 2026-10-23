import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "./scoped.ts";
describe("scoped refs", () => {
  const environmentId = EnvironmentId.make("environment-test");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
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
