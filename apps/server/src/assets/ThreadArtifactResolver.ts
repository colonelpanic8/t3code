import type { MessageId, TurnId } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

interface ThreadArtifactSource {
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly payload: unknown;
    readonly createdAt: string;
  }>;
}

export type ResolvedThreadArtifactPath =
  | {
      readonly path: string;
      readonly scope: "workspace";
      readonly source: "raw-output" | "image-view";
    }
  | {
      readonly path: string;
      readonly scope: "provider-generated";
      readonly source: "image-generation";
    };

const THREAD_ARTIFACT_LOOKUP_RETRY_COUNT = 4;
const THREAD_ARTIFACT_LOOKUP_RETRY_INTERVAL = "100 millis";

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function retryThreadArtifactLookup<A, E, R>(
  lookup: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return lookup.pipe(
    Effect.retry({
      times: THREAD_ARTIFACT_LOOKUP_RETRY_COUNT,
      schedule: Schedule.spaced(THREAD_ARTIFACT_LOOKUP_RETRY_INTERVAL),
      while: isThreadArtifactLookupRetryable,
    }),
  );
}

export function isThreadArtifactLookupRetryable(error: unknown): boolean {
  return asUnknownRecord(error)?._tag === "AssetWorkspaceAssetNotFoundError";
}

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export function normalizeThreadArtifactReference(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(normalized) ||
    normalized.includes(":") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    !isWorkspaceImagePreviewPath(normalized)
  ) {
    return null;
  }
  return normalized;
}

function activityArtifactPaths(payloadValue: unknown): ReadonlyArray<ResolvedThreadArtifactPath> {
  const payload = asUnknownRecord(payloadValue);
  const data = asUnknownRecord(payload?.data);
  const rawOutput = asUnknownRecord(data?.rawOutput);
  const item = asUnknownRecord(data?.item);
  const paths: ResolvedThreadArtifactPath[] = [];

  if (typeof rawOutput?.path === "string") {
    paths.push({ path: rawOutput.path, scope: "workspace", source: "raw-output" });
  }

  if (item?.type === "imageGeneration" && typeof item.savedPath === "string") {
    paths.push({
      path: item.savedPath,
      scope: "provider-generated",
      source: "image-generation",
    });
  } else if (item?.type === "imageView" && typeof item.path === "string") {
    paths.push({ path: item.path, scope: "workspace", source: "image-view" });
  }

  return paths;
}

function artifactMessageWindow(
  thread: ThreadArtifactSource,
  turnId: TurnId,
  messageId: MessageId,
): { readonly after: number; readonly before: number } | null {
  const messages = thread.messages
    .filter((message) => message.role === "assistant" && message.turnId === turnId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  const message = messages[messageIndex];
  if (!message) return null;

  const before = Date.parse(message.updatedAt);
  const previousMessage = messages[messageIndex - 1];
  const after = previousMessage ? Date.parse(previousMessage.updatedAt) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(before) || Number.isNaN(after) ? null : { after, before };
}

export function findThreadArtifactPath(
  thread: ThreadArtifactSource,
  turnId: TurnId,
  messageId: MessageId,
  reference: string,
): ResolvedThreadArtifactPath | null {
  const normalizedReference = normalizeThreadArtifactReference(reference);
  if (!normalizedReference) return null;
  const window = artifactMessageWindow(thread, turnId, messageId);
  if (!window) return null;

  const matches = new Map<string, ResolvedThreadArtifactPath>();
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId) continue;
    const createdAt = Date.parse(activity.createdAt);
    if (Number.isNaN(createdAt) || createdAt < window.after || createdAt > window.before) continue;

    for (const artifact of activityArtifactPaths(activity.payload)) {
      const candidate = artifact.path.trim();
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      if (
        normalizedCandidate === normalizedReference ||
        normalizedCandidate.endsWith(`/${normalizedReference}`)
      ) {
        // Scope is part of candidate identity. Seeing the same path as both a
        // workspace artifact and a provider-generated artifact is ambiguous,
        // rather than an opportunity to upgrade it to the broader scope.
        matches.set(`${artifact.scope}\0${normalizedCandidate}`, {
          ...artifact,
          path: candidate,
        });
      }
    }
  }

  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}
