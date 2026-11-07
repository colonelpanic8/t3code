import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationReadScope, type AuthMcpClientAccess } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ManagedPeerLinks from "./ManagedPeerLinks.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
  type ServedPeer,
} from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("fleet:laptop", "Laptop");
const box = descriptorOf("fleet:box", "Box");

/** Environment A, which keeps the links its managed peer links file at `path` lists. */
const makeA = (path: string) =>
  Effect.gen(function* () {
    const context = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-peers-" })),
    );
    const managed = yield* ManagedPeerLinks.layer.pipe(
      Layer.provide(
        Layer.succeed(ServerConfig.ServerConfig, { ...config, managedPeerLinksPath: path }),
      ),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.build,
    );
    return {
      links: Context.get(context, PeerLinks.PeerLinks),
      reconcile: Context.get(managed, ManagedPeerLinks.ManagedPeerLinks).reconcile,
    };
  });

const enrollmentAt = (
  peer: ServedPeer,
  scopes?: ReadonlyArray<typeof AuthOrchestrationReadScope>,
) =>
  peer.auth
    .createFleetEnrollment({
      ttl: Duration.days(365),
      label: "Fleet",
      ...(scopes === undefined ? {} : { scopes }),
    })
    .pipe(Effect.map((issued) => Redacted.value(issued.credential)));

it.effect("keeps the links a managed peer links file lists, and only those", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-peers-file-" });
      const path = `${dir}/managed-peer-links.json`;
      const codePath = `${dir}/box-enrollment`;
      const b = yield* servePeer(box, Layer.empty);
      const a = yield* makeA(path);
      const writeLinks = (access: AuthMcpClientAccess | undefined) =>
        fs.writeFileString(
          path,
          JSON.stringify({
            version: 1,
            links:
              access === undefined
                ? []
                : [
                    {
                      environmentId: box.environmentId,
                      label: "Box",
                      urls: [b.url],
                      access,
                      pairingCode: { $file: codePath },
                    },
                  ],
          }),
        );

      // An enrollment without the scopes full access needs cannot make that link.
      yield* fs.writeFileString(codePath, yield* enrollmentAt(b, [AuthOrchestrationReadScope]));
      yield* writeLinks("full-access");
      const refused = yield* a.reconcile;
      expect(refused.linked).toEqual([]);
      expect(refused.failed.map((failure) => failure.environmentId)).toEqual([box.environmentId]);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());

      yield* fs.writeFileString(codePath, `${yield* enrollmentAt(b)}\n`);
      expect(yield* a.reconcile).toMatchObject({ linked: [box.environmentId], failed: [] });
      expect(Option.getOrThrow(yield* a.links.get(box.environmentId)).access).toBe("full-access");
      expect((yield* b.linkedSessions).map((session) => session.client.label)).toEqual([
        "T3 Code · Laptop",
      ]);

      // An unchanged entry with a fresh link is left as it is.
      expect(yield* a.reconcile).toMatchObject({ linked: [], unchanged: [box.environmentId] });

      // The enrollment is reusable, so a changed entry links again with it.
      yield* writeLinks("auto");
      expect(yield* a.reconcile).toMatchObject({ linked: [box.environmentId] });
      expect(Option.getOrThrow(yield* a.links.get(box.environmentId)).access).toBe("auto");

      // A file that cannot be read changes nothing.
      yield* fs.writeFileString(path, "{");
      expect((yield* a.reconcile).skipped).toContain("not a valid managed peer links file");
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);

      // Removing the entry unlinks it here.
      yield* writeLinks(undefined);
      expect(yield* a.reconcile).toMatchObject({ unlinked: [box.environmentId] });
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());

      // A link made by hand is not the file's to remove.
      yield* linkTo(a.links, b);
      expect(yield* a.reconcile).toMatchObject({ unlinked: [] });
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
);
