import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  type EnvironmentId as EnvironmentIdType,
  type ProjectId as ProjectIdType,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeScopedRefKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([EnvironmentId, TrimmedNonEmptyString])),
);

export function scopeProjectRef(
  environmentId: EnvironmentIdType,
  projectId: ProjectIdType,
): ScopedProjectRef {
  return { environmentId, projectId };
}

export function scopeThreadRef(
  environmentId: EnvironmentIdType,
  threadId: ThreadId,
): ScopedThreadRef {
  return { environmentId, threadId };
}

function scopedRefKey(ref: ScopedProjectRef | ScopedThreadRef): string {
  const localId = "projectId" in ref ? ref.projectId : ref.threadId;
  // Keep existing storage keys unless their environment would make the delimiter ambiguous.
  if (ref.environmentId.includes(":") || ref.environmentId.startsWith("[")) {
    return JSON.stringify([ref.environmentId, localId]);
  }
  return `${ref.environmentId}:${localId}`;
}

export function scopedProjectKey(ref: ScopedProjectRef): string {
  return scopedRefKey(ref);
}

export function scopedThreadKey(ref: ScopedThreadRef): string {
  return scopedRefKey(ref);
}

function parseScopedKey(key: string): { environmentId: EnvironmentIdType; localId: string } | null {
  if (key.startsWith("[")) {
    const parsed = decodeScopedRefKey(key);
    return Option.isSome(parsed)
      ? { environmentId: parsed.value[0], localId: parsed.value[1] }
      : null;
  }
  const separatorIndex = key.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(key.slice(0, separatorIndex)),
    localId: key.slice(separatorIndex + 1),
  };
}

export function parseScopedProjectKey(key: string): ScopedProjectRef | null {
  const parsed = parseScopedKey(key);
  if (!parsed) {
    return null;
  }
  return {
    environmentId: parsed.environmentId,
    projectId: ProjectId.make(parsed.localId),
  };
}

export function parseScopedThreadKey(key: string): ScopedThreadRef | null {
  const parsed = parseScopedKey(key);
  if (!parsed) {
    return null;
  }
  return {
    environmentId: parsed.environmentId,
    threadId: ThreadId.make(parsed.localId),
  };
}
