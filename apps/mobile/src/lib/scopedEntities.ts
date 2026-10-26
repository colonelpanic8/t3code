import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  scopedProjectKey as projectKey,
  scopedThreadKey as threadKey,
} from "@t3tools/client-runtime/environment";

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return projectKey({ environmentId, projectId });
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return threadKey({ environmentId, threadId });
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  requestId: RuntimeRequestId,
): string {
  return `${environmentId}:${requestId}`;
}
