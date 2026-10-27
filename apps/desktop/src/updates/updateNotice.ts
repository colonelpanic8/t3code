import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type DesktopUpdateNoticeFeed, isFullCommitSha } from "../app/DesktopConfig.ts";

const FETCH_TIMEOUT = Duration.seconds(30);

export type DesktopUpdateNotice =
  | { readonly _tag: "up-to-date" }
  | { readonly _tag: "available"; readonly version: string; readonly url: string };

export class DesktopUpdateNoticeCheckError extends Schema.TaggedError<DesktopUpdateNoticeCheckError>()(
  "DesktopUpdateNoticeCheckError",
  {
    repository: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the latest build published to ${this.repository} ${this.branch}.`;
  }
}

export function resolveDesktopUpdateNotice(
  feed: DesktopUpdateNoticeFeed,
  publishedCommit: string,
): DesktopUpdateNotice {
  if (publishedCommit === feed.commit) return { _tag: "up-to-date" };
  return {
    _tag: "available",
    version: publishedCommit.slice(0, 8),
    url: `https://github.com/${feed.repository}/compare/${feed.commit}...${publishedCommit}`,
  };
}

export const fetchPublishedCommit = Effect.fn("desktop.updates.fetchPublishedCommit")(function* (
  feed: DesktopUpdateNoticeFeed,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://api.github.com/repos/${feed.repository}/commits/${encodeURIComponent(feed.branch)}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      Accept: "application/vnd.github.sha",
      // GitHub's API rejects requests without a User-Agent.
      "User-Agent": "T3-Code-Desktop",
    }),
  );
  return yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(FETCH_TIMEOUT),
    Effect.map((body) => body.trim().toLowerCase()),
    Effect.filterOrFail(
      isFullCommitSha,
      (body) =>
        new Error(`GitHub returned ${JSON.stringify(body.slice(0, 64))}, not a commit sha.`),
    ),
    Effect.mapError(
      (cause) =>
        new DesktopUpdateNoticeCheckError({
          repository: feed.repository,
          branch: feed.branch,
          cause,
        }),
    ),
  );
});
