/**
 * Keeps each environment's last usage summaries across reloads, so the Usage
 * page can draw them, muted, while a cold scan or a reconnect is under way.
 *
 * A separate database from the connection cache: its schema version moves
 * independently, and a client that cannot open it only loses this cache.
 */
import type { QueryStore } from "@t3tools/client-runtime/state/query-persistence";
import type { EnvironmentId } from "@t3tools/contracts";
import { startOfLocalDay } from "@t3tools/shared/usageFormat";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DATABASE_NAME = "t3code:usage-summaries";
const DATABASE_VERSION = 1;
const STORE_NAME = "summaries";
/** Every window option for eight environments. */
export const MAX_STORED_USAGE_SUMMARIES = 32;

const StoredUsageSummary = Schema.Struct({ payload: Schema.String, savedAt: Schema.Number });
type StoredUsageSummary = typeof StoredUsageSummary.Type;
const isStoredUsageSummary = Schema.is(StoredUsageSummary);

export interface UsageSummaryBackend {
  readonly get: (id: string) => Effect.Effect<unknown, Cause.UnknownError>;
  readonly put: (id: string, record: StoredUsageSummary) => Effect.Effect<void, Cause.UnknownError>;
  readonly remove: (ids: ReadonlyArray<string>) => Effect.Effect<void, Cause.UnknownError>;
  readonly entries: Effect.Effect<
    ReadonlyArray<readonly [id: string, record: unknown]>,
    Cause.UnknownError
  >;
}

const recordId = (environmentId: EnvironmentId, key: string) => `${environmentId}:${key}`;

/**
 * Every window ends when it is requested, so a summary saved before today
 * describes a window that ended before today.
 */
function isCurrent(record: unknown, now: number): record is StoredUsageSummary {
  return isStoredUsageSummary(record) && record.savedAt >= startOfLocalDay(new Date(now)).getTime();
}

export function makeUsageSummaryStore(
  backend: UsageSummaryBackend,
  { now = Date.now, maxEntries = MAX_STORED_USAGE_SUMMARIES } = {},
): QueryStore {
  const prune = backend.entries.pipe(
    Effect.flatMap((entries) => {
      const current = entries
        .flatMap(([id, record]) =>
          isCurrent(record, now()) ? [{ id, savedAt: record.savedAt }] : [],
        )
        .toSorted((a, b) => b.savedAt - a.savedAt);
      const kept = new Set(current.slice(0, maxEntries).map(({ id }) => id));
      const dropped = entries.flatMap(([id]) => (kept.has(id) ? [] : [id]));
      return dropped.length === 0 ? Effect.void : backend.remove(dropped);
    }),
  );
  return {
    load: (environmentId, key) => {
      const id = recordId(environmentId, key);
      return backend.get(id).pipe(
        Effect.flatMap((record) => {
          if (record === undefined) return Effect.succeedNone;
          if (isCurrent(record, now())) return Effect.succeedSome(record.payload);
          return backend.remove([id]).pipe(Effect.as(Option.none<string>()));
        }),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    },
    save: (environmentId, key, payload) =>
      backend.put(recordId(environmentId, key), { payload, savedAt: now() }).pipe(
        Effect.andThen(prune),
        Effect.catch(() => Effect.logWarning("Could not save the usage summary cache.")),
      ),
    remove: (environmentId, key) =>
      backend.remove([recordId(environmentId, key)]).pipe(Effect.ignore),
  };
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => {
      const opened = request.result;
      const forget = () => {
        database = undefined;
      };
      opened.addEventListener("close", forget);
      opened.addEventListener("versionchange", () => {
        forget();
        opened.close();
      });
      resolve(opened);
    });
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Usage cache is blocked.")));
  }).catch((cause: unknown) => {
    database = undefined;
    throw cause;
  });
  return database;
}

/** `use` queues requests; its returned reader runs once the transaction commits. */
function transact<A>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => () => A) {
  return Effect.tryPromise(async () => {
    const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
    const read = use(transaction.objectStore(STORE_NAME));
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    return read();
  });
}

const indexedDbBackend: UsageSummaryBackend = {
  get: (id) =>
    transact("readonly", (store) => {
      const request = store.get(id);
      return (): unknown => request.result;
    }),
  put: (id, record) =>
    transact("readwrite", (store) => {
      store.put(record, id);
      return () => undefined;
    }),
  remove: (ids) =>
    transact("readwrite", (store) => {
      for (const id of ids) store.delete(id);
      return () => undefined;
    }),
  entries: transact("readonly", (store) => {
    const keys = store.getAllKeys();
    const values = store.getAll();
    return () => keys.result.map((key, index) => [String(key), values.result[index]] as const);
  }),
};

export const usageSummaryStore = makeUsageSummaryStore(indexedDbBackend);

export function clearUsageSummaries(environmentId: EnvironmentId) {
  return transact("readwrite", (store) => {
    store.delete(IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:￿`));
    return () => undefined;
  }).pipe(Effect.ignore);
}
