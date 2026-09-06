import { describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { DirectAudioOutboxRecord } from "./outbox";

// Vite query suffixes deliberately create separate module instances, matching
// independent browser realms that cannot share the module-level WeakMap.
// @ts-ignore -- TypeScript does not model Vite query-suffixed modules.
import * as indexedDbRealm0 from "./indexeddb-outbox?realm=0";
// @ts-ignore -- TypeScript does not model Vite query-suffixed modules.
import * as indexedDbRealm1 from "./indexeddb-outbox?realm=1";
// @ts-ignore -- TypeScript does not model Vite query-suffixed modules.
import * as indexedDbRealm2 from "./indexeddb-outbox?realm=2";
// @ts-ignore -- TypeScript does not model Vite query-suffixed modules.
import * as indexedDbRealm3 from "./indexeddb-outbox?realm=3";
// @ts-ignore -- TypeScript does not model Vite query-suffixed modules.
import * as indexedDbRealm4 from "./indexeddb-outbox?realm=4";

const realms: Array<typeof import("./indexeddb-outbox")> = [
  indexedDbRealm0,
  indexedDbRealm1,
  indexedDbRealm2,
  indexedDbRealm3,
  indexedDbRealm4
] as Array<typeof import("./indexeddb-outbox")>;

describe("IndexedDB cross-realm schema coordination", () => {
  it("reopens through concurrent custom-store upgrades and preserves host data", async () => {
    expect(realms[0]?.createIndexedDbDirectAudioOutboxStore).not.toBe(
      realms[1]?.createIndexedDbDirectAudioOutboxStore
    );
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-cross-realm-schema-upgrades";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("host-data", { keyPath: "id" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("host-data", "readwrite");
        transaction.objectStore("host-data").put({ id: "host-row-1", keep: true });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    const encoded = new Map<string, DirectAudioOutboxRecord>();
    const stores = realms.map((realm, index) => {
      const storeName = `realm-voice-${index}`;
      return realm.createIndexedDbDirectAudioOutboxStore<string>({
        indexedDB,
        keyRange: IDBKeyRange,
        databaseName,
        storeName,
        partition: "opaque-cross-realm-owner",
        codec: {
          async encode(record) {
            const token = `${storeName}:${record.clientTurnId}`;
            encoded.set(token, record);
            await Promise.resolve();
            return token;
          },
          async decode(token) {
            const record = encoded.get(token);
            if (!record) throw new Error("missing cross-realm payload");
            return record;
          }
        }
      });
    });

    await Promise.all(
      stores.map((store, index) =>
        store.put({
          version: 1,
          clientTurnId: `turn-cross-realm-${index}`,
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
          audio: {
            blob: new Blob([`audio-${index}`], { type: "audio/webm" }),
            mimeType: "audio/webm",
            durationMs: 500,
            size: 7
          }
        })
      )
    );

    await expect(
      Promise.all(
        stores.map(async (store, index) => ({
          epoch: await store.getPartitionEpoch(),
          ids: (await store.list()).map((record) => record.clientTurnId),
          exact: (await store.get(`turn-cross-realm-${index}`))?.clientTurnId
        }))
      )
    ).resolves.toEqual(
      stores.map((_, index) => ({
        epoch: 0,
        ids: [`turn-cross-realm-${index}`],
        exact: `turn-cross-realm-${index}`
      }))
    );

    const hostRow = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("host-data", "readonly");
        const get = transaction.objectStore("host-data").get("host-row-1");
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
        transaction.oncomplete = () => database.close();
      };
    });
    expect(hostRow).toEqual({ id: "host-row-1", keep: true });
  });
});
