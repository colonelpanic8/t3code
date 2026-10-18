import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  projectFaviconResource,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment, assetUrlRevalidate } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (blocked !== null) return blocked;
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  }, [environmentId, resource, refresh, httpBaseUrl]);
}

/**
 * Project icon URLs name the file the server found and a hash of its bytes, and the server caches
 * that lookup. Revalidating first re-runs the lookup, so the shared query refresh that follows picks
 * up an icon that was added, replaced, or moved, and a changed hash gets past every image cache.
 */
export function useProjectFaviconRefresh(project: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly faviconPath?: string | null | undefined;
}): () => void {
  const resource = projectFaviconResource(project.workspaceRoot, project.faviconPath);
  const revalidate = useAtomCommand(assetUrlRevalidate, { reportFailure: false });
  const refresh = useAssetUrlRefresh(project.environmentId, resource);
  return () => {
    void revalidate({
      environmentId: project.environmentId,
      input: { resource, revalidate: true },
    })
      .then(() => refresh())
      .catch(() => {});
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = useMemo(
    () =>
      canReadFiles
        ? resources
        : resources.filter(
            (resource) =>
              resource._tag !== "workspace-file" &&
              resource._tag !== "media-file" &&
              resource._tag !== "draft-workspace-file",
          ),
    [canReadFiles, resources],
  );
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  return useMemo(() => {
    if (preparedConnection._tag === "None") return resources.map(() => null);
    let resultIndex = 0;
    return resources.map((resource) => {
      if (
        !canReadFiles &&
        (resource._tag === "workspace-file" ||
          resource._tag === "media-file" ||
          resource._tag === "draft-workspace-file")
      )
        return null;
      const result = results[resultIndex++];
      return result && AsyncResult.isSuccess(result)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null;
    });
  }, [canReadFiles, preparedConnection, resources, results]);
}
