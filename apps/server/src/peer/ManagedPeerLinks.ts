import {
  AuthMcpClientAccess,
  EnvironmentId,
  type PeerLinkError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** A secret given inline or, so the file itself holds none, as a path to read. */
const SecretValue = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Struct({ $file: TrimmedNonEmptyString }),
]);

const ManagedPeerLinkEntry = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  /** Addresses tried in order; only those that answer as `environmentId` are kept. */
  urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  /** A credential the peer accepts as a pairing code more than once, such as a fleet enrollment. */
  pairingCode: SecretValue,
});
export type ManagedPeerLinkEntry = typeof ManagedPeerLinkEntry.Type;

export const ManagedPeerLinksFile = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(ManagedPeerLinkEntry),
});
export type ManagedPeerLinksFile = typeof ManagedPeerLinksFile.Type;

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedPeerLinksFile));

/** A link is made again this long before its token expires. */
const RENEW_BEFORE = Duration.days(3);

export interface ManagedPeerLinksReport {
  readonly linked: ReadonlyArray<EnvironmentId>;
  readonly unchanged: ReadonlyArray<EnvironmentId>;
  readonly unlinked: ReadonlyArray<EnvironmentId>;
  readonly failed: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly message: string;
  }>;
  /** Why nothing was changed, when the file could not be used. */
  readonly skipped?: string;
}

/** The file is applied again on this schedule, so a peer that was asleep is linked once it answers. */
const RECONCILE_SCHEDULE = Schedule.spaced(Duration.minutes(5));

/**
 * Keeps the links `T3CODE_MANAGED_PEER_LINKS_FILE` lists. The file owns them: an entry is linked
 * again when it changes or its link nears expiry, and a link whose entry is gone (all of them when
 * no file is set) is unlinked. Links made by hand are left alone.
 */
export class ManagedPeerLinks extends Context.Service<
  ManagedPeerLinks,
  {
    readonly reconcile: Effect.Effect<ManagedPeerLinksReport>;
    /** Applies the file now and then periodically for the scope's lifetime. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/ManagedPeerLinks") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const links = yield* PeerLinks.PeerLinks;

  const readSecret = (value: typeof SecretValue.Type) =>
    typeof value === "string"
      ? Effect.succeed(value)
      : fileSystem.readFileString(value.$file).pipe(
          Effect.mapError(() => `its pairing code file ${value.$file} could not be read`),
          Effect.map((contents) => contents.trim()),
          Effect.filterOrFail(
            (code) => code.length > 0,
            () => `its pairing code file ${value.$file} is empty`,
          ),
        );

  /** Changes whenever linking again would give a different link. */
  const fingerprintOf = (entry: ManagedPeerLinkEntry, pairingCode: string) =>
    digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          JSON.stringify([entry.environmentId, entry.urls, entry.access, pairingCode]),
        ),
      )
      .pipe(
        Effect.map((bytes) => Hex.encode(bytes).slice(0, 16)),
        Effect.orDie,
      );

  const readEntries = Effect.gen(function* () {
    const path = config.managedPeerLinksPath;
    if (path === undefined) return [];
    const raw = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.mapError(() => `${path} could not be read`));
    const file = yield* decodeFile(raw).pipe(
      Effect.mapError(
        (cause) => `${path} is not a valid managed peer links file: ${cause.message}`,
      ),
    );
    return file.links;
  });

  const linkEntry = Effect.fn("ManagedPeerLinks.linkEntry")(function* (
    entry: ManagedPeerLinkEntry,
    managed: ReadonlyMap<EnvironmentId, PeerLinks.ManagedPeerLinkRow>,
    renewBy: DateTime.Utc,
  ) {
    const pairingCode = yield* readSecret(entry.pairingCode);
    const fingerprint = yield* fingerprintOf(entry, pairingCode);
    const current = managed.get(entry.environmentId);
    if (
      current !== undefined &&
      current.fingerprint === fingerprint &&
      DateTime.isGreaterThan(current.expiresAt, renewBy)
    ) {
      return "unchanged" as const;
    }
    const [url, ...alternateUrls] = entry.urls;
    yield* links
      .link(
        {
          url,
          ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
          pairingCode,
          access: entry.access,
          expectedEnvironmentId: entry.environmentId,
          expectedLabel: entry.label ?? entry.environmentId,
        },
        { managedFingerprint: fingerprint },
      )
      .pipe(Effect.mapError((error: PeerLinkError) => error.message));
    return "linked" as const;
  });

  const reconcile: ManagedPeerLinks["Service"]["reconcile"] = Effect.gen(function* () {
    if (!(yield* links.enabled)) {
      return {
        linked: [],
        unchanged: [],
        unlinked: [],
        failed: [],
        skipped: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      } satisfies ManagedPeerLinksReport;
    }
    const entries = yield* readEntries;
    const managed = new Map(
      (yield* links.listManaged).map((row) => [row.environmentId, row] as const),
    );
    const renewBy = DateTime.addDuration(yield* DateTime.now, RENEW_BEFORE);
    const outcomes = yield* Effect.forEach(
      entries,
      (entry) =>
        linkEntry(entry, managed, renewBy).pipe(
          Effect.result,
          Effect.map((result) => ({ environmentId: entry.environmentId, result })),
        ),
      { concurrency: "unbounded" },
    );
    const listed = new Set(entries.map((entry) => entry.environmentId));
    const removed = [...managed.keys()].filter((environmentId) => !listed.has(environmentId));
    yield* Effect.forEach(removed, links.unlink, { discard: true });
    const report: ManagedPeerLinksReport = {
      linked: outcomes.flatMap((outcome) =>
        outcome.result._tag === "Success" && outcome.result.success === "linked"
          ? [outcome.environmentId]
          : [],
      ),
      unchanged: outcomes.flatMap((outcome) =>
        outcome.result._tag === "Success" && outcome.result.success === "unchanged"
          ? [outcome.environmentId]
          : [],
      ),
      unlinked: removed,
      failed: outcomes.flatMap((outcome) =>
        outcome.result._tag === "Failure"
          ? [{ environmentId: outcome.environmentId, message: outcome.result.failure }]
          : [],
      ),
    };
    return report;
  }).pipe(
    Effect.catch((error: PeerLinkError | string) =>
      Effect.succeed({
        linked: [],
        unchanged: [],
        unlinked: [],
        failed: [],
        skipped: typeof error === "string" ? error : error.message,
      } satisfies ManagedPeerLinksReport),
    ),
    Effect.tap((report) =>
      Effect.all(
        [
          report.skipped !== undefined && config.managedPeerLinksPath !== undefined
            ? Effect.logWarning("Managed peer links were not applied", { reason: report.skipped })
            : Effect.void,
          report.linked.length > 0 || report.unlinked.length > 0
            ? Effect.logInfo("Managed peer links applied", {
                linked: report.linked,
                unlinked: report.unlinked,
              })
            : Effect.void,
          ...report.failed.map((failure) =>
            Effect.logWarning("A managed peer link could not be made", failure),
          ),
        ],
        { discard: true },
      ),
    ),
    Effect.withSpan("ManagedPeerLinks.reconcile"),
  );

  const start: ManagedPeerLinks["Service"]["start"] = Effect.fn("ManagedPeerLinks.start")(
    function* () {
      yield* forkParked(
        reconcile.pipe(Effect.repeat(RECONCILE_SCHEDULE), Effect.ignoreCause({ log: true })),
      );
    },
  );

  return ManagedPeerLinks.of({ reconcile, start });
});

export const layer = Layer.effect(ManagedPeerLinks, make);
