import {
  createStableClientTurnId,
  type DirectAudioOutboxRecord,
  type DirectAudioOutboxSendLease,
  type DirectAudioOutboxStore
} from "./outbox";
import { VoiceInputError } from "./types";

export interface DirectAudioOutboxCodec<StoredPayload = unknown> {
  encode(record: DirectAudioOutboxRecord): Promise<StoredPayload>;
  decode(payload: StoredPayload): Promise<DirectAudioOutboxRecord>;
}

export interface IndexedDbDirectAudioOutboxOptions<StoredPayload = unknown> {
  codec: DirectAudioOutboxCodec<StoredPayload>;
  partition: string;
  indexedDB?: IDBFactory;
  keyRange?: Pick<typeof IDBKeyRange, "bound">;
  databaseName?: string;
  storeName?: string;
}

export interface IndexedDbPartitionClaimInput<TargetPayload> {
  clientTurnId: string;
  targetPartition: string;
  targetCodec: DirectAudioOutboxCodec<TargetPayload>;
  transform(record: DirectAudioOutboxRecord): DirectAudioOutboxRecord;
  /** Aborts the local re-key transaction while it is still in flight. */
  signal?: AbortSignal;
}

export interface IndexedDbDirectAudioOutboxStore extends DirectAudioOutboxStore {
  readonly partition: string;
  getPartitionEpoch(): Promise<number>;
  claimTo<TargetPayload>(
    input: IndexedDbPartitionClaimInput<TargetPayload>
  ): Promise<DirectAudioOutboxRecord>;
}

interface StoredSendLease {
  token: string;
  partitionEpoch: number;
  revision: string;
  expiresAt: number;
}

interface StoredRow<StoredPayload = unknown> {
  partition: string;
  clientTurnId: string;
  createdAt: string;
  revision?: string;
  sendLease?: StoredSendLease;
  payload: StoredPayload;
}

interface PartitionControlRow {
  partition: string;
  epoch: number;
}

interface ClaimSnapshot<StoredPayload> {
  sourceEpoch: number;
  targetEpoch: number;
  row: StoredRow<StoredPayload>;
}

const SEND_LEASE_TTL_MS = 5 * 60 * 1000;
const INDEXED_DB_RETRY_LIMIT = 32;
const STORE_REGISTRY_NAME = "editable-voice-input-outbox-store-registry";
const PARTITION_STORE_PREFIX = "editable-voice-input-outbox-partitions:";
const DEFAULT_STORE_NAME = "pending-audio";
const LEGACY_DEFAULT_CONTROL_STORE_NAME = "pending-audio-partitions";

interface RegisteredOutboxSchema {
  storeName: string;
  controlStoreName: string;
}

interface IndexedDbCoordinator {
  factory: IDBFactory;
  databaseName: string;
  schemas: Map<string, RegisteredOutboxSchema>;
  databasePromise: Promise<IDBDatabase> | null;
  currentDatabase: IDBDatabase | null;
}

const DATABASE_COORDINATORS = new WeakMap<
  IDBFactory,
  Map<string, IndexedDbCoordinator>
>();

function isKeyPath(keyPath: string | string[] | null, expected: string | string[]): boolean {
  if (typeof expected === "string") return keyPath === expected;
  return (
    Array.isArray(keyPath) &&
    keyPath.length === expected.length &&
    keyPath.every((part, index) => part === expected[index])
  );
}

function schemaConflict(storeName: string): VoiceInputError {
  return new VoiceInputError(
    "submission-failed",
    `IndexedDB store "${storeName}" already exists with an incompatible keyPath; no data was changed.`
  );
}

function getCoordinator(factory: IDBFactory, databaseName: string): IndexedDbCoordinator {
  let databases = DATABASE_COORDINATORS.get(factory);
  if (!databases) {
    databases = new Map();
    DATABASE_COORDINATORS.set(factory, databases);
  }
  let coordinator = databases.get(databaseName);
  if (!coordinator) {
    coordinator = {
      factory,
      databaseName,
      schemas: new Map(),
      databasePromise: null,
      currentDatabase: null
    };
    databases.set(databaseName, coordinator);
  }
  return coordinator;
}

function databaseHasSchemas(database: IDBDatabase, coordinator: IndexedDbCoordinator): boolean {
  if (!database.objectStoreNames.contains(STORE_REGISTRY_NAME)) return false;
  const registry = database
    .transaction(STORE_REGISTRY_NAME, "readonly")
    .objectStore(STORE_REGISTRY_NAME);
  if (!isKeyPath(registry.keyPath, "storeName")) throw schemaConflict(STORE_REGISTRY_NAME);
  for (const schema of coordinator.schemas.values()) {
    if (
      !database.objectStoreNames.contains(schema.storeName) ||
      !database.objectStoreNames.contains(schema.controlStoreName)
    ) {
      return false;
    }
    const stores = database.transaction(
      [schema.storeName, schema.controlStoreName],
      "readonly"
    );
    if (
      !isKeyPath(stores.objectStore(schema.storeName).keyPath, [
        "partition",
        "clientTurnId"
      ]) ||
      !isKeyPath(stores.objectStore(schema.controlStoreName).keyPath, "partition")
    ) {
      throw schemaConflict(schema.storeName);
    }
  }
  return true;
}

function ensureRegisteredSchemas(
  database: IDBDatabase,
  transaction: IDBTransaction,
  coordinator: IndexedDbCoordinator
): void {
  if (database.objectStoreNames.contains(STORE_REGISTRY_NAME)) {
    if (!isKeyPath(transaction.objectStore(STORE_REGISTRY_NAME).keyPath, "storeName")) {
      throw schemaConflict(STORE_REGISTRY_NAME);
    }
  } else {
    database.createObjectStore(STORE_REGISTRY_NAME, { keyPath: "storeName" });
  }
  for (const schema of coordinator.schemas.values()) {
    if (database.objectStoreNames.contains(schema.storeName)) {
      const existing = transaction.objectStore(schema.storeName);
      if (!isKeyPath(existing.keyPath, ["partition", "clientTurnId"])) {
        if (schema.storeName !== DEFAULT_STORE_NAME) {
          // A custom name may belong to the host application. Never destroy it
          // merely because it collides with this library's requested schema.
          throw schemaConflict(schema.storeName);
        }
        // The default store is the library's known v1 unpartitioned schema.
        database.deleteObjectStore(schema.storeName);
        database.createObjectStore(schema.storeName, {
          keyPath: ["partition", "clientTurnId"]
        });
      }
    } else {
      database.createObjectStore(schema.storeName, {
        keyPath: ["partition", "clientTurnId"]
      });
    }
    if (database.objectStoreNames.contains(schema.controlStoreName)) {
      if (!isKeyPath(transaction.objectStore(schema.controlStoreName).keyPath, "partition")) {
        throw schemaConflict(schema.controlStoreName);
      }
    } else {
      database.createObjectStore(schema.controlStoreName, { keyPath: "partition" });
    }
  }
}

function resetCoordinatorDatabase(
  coordinator: IndexedDbCoordinator,
  database?: IDBDatabase
): void {
  const target = database ?? coordinator.currentDatabase;
  target?.close();
  if (!database || coordinator.currentDatabase === database) {
    coordinator.currentDatabase = null;
    coordinator.databasePromise = null;
  }
}

function isRetryableIndexedDbRace(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  return [
    "AbortError",
    "InvalidStateError",
    "TransactionInactiveError",
    "UnknownError",
    "VersionError"
  ].includes(name);
}

function yieldForIndexedDbRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(attempt, 8)));
}

function openCoordinatedDatabase(
  coordinator: IndexedDbCoordinator,
  retryAttempt = 0
): Promise<IDBDatabase> {
  if (coordinator.databasePromise) return coordinator.databasePromise;
  const openExisting = (): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve, reject) => {
      let upgradeError: unknown = null;
      let settled = false;
      let blockedTimer: ReturnType<typeof setTimeout> | undefined;
      const clearBlockedTimer = (): void => {
        if (blockedTimer !== undefined) clearTimeout(blockedTimer);
      };
      const resolveOnce = (database: IDBDatabase): void => {
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        clearBlockedTimer();
        resolve(database);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearBlockedTimer();
        reject(error);
      };
      const request = coordinator.factory.open(coordinator.databaseName);
      request.onupgradeneeded = () => {
        try {
          ensureRegisteredSchemas(request.result, request.transaction!, coordinator);
        } catch (error) {
          upgradeError = error;
          request.transaction?.abort();
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => resetCoordinatorDatabase(coordinator, database);
        try {
          if (databaseHasSchemas(database, coordinator)) {
            resolveOnce(database);
            return;
          }
        } catch (error) {
          database.close();
          rejectOnce(error);
          return;
        }
        const nextVersion = database.version + 1;
        database.close();
        const upgrade = coordinator.factory.open(coordinator.databaseName, nextVersion);
        upgrade.onupgradeneeded = () => {
          try {
            ensureRegisteredSchemas(upgrade.result, upgrade.transaction!, coordinator);
          } catch (error) {
            upgradeError = error;
            upgrade.transaction?.abort();
          }
        };
        upgrade.onsuccess = () => {
          const upgraded = upgrade.result;
          if (settled) {
            upgraded.close();
            return;
          }
          upgraded.onversionchange = () =>
            resetCoordinatorDatabase(coordinator, upgraded);
          try {
            if (databaseHasSchemas(upgraded, coordinator)) {
              resolveOnce(upgraded);
              return;
            }
          } catch (error) {
            upgraded.close();
            rejectOnce(error);
            return;
          }
          upgraded.close();
          openExisting().then(resolveOnce, rejectOnce);
        };
        upgrade.onerror = () =>
          rejectOnce(
            upgradeError ??
              upgrade.error ??
              new Error("IndexedDB schema upgrade failed.")
          );
        upgrade.onblocked = () => {
          blockedTimer ??= setTimeout(
            () => rejectOnce(new Error("IndexedDB schema upgrade was blocked.")),
            2_000
          );
        };
      };
      request.onerror = () =>
        rejectOnce(
          upgradeError ?? request.error ?? new Error("IndexedDB could not open.")
        );
    });
  const pending = openExisting()
    .then(async (database) => {
      coordinator.currentDatabase = database;
      const transaction = database.transaction(STORE_REGISTRY_NAME, "readwrite");
      const registry = transaction.objectStore(STORE_REGISTRY_NAME);
      for (const schema of coordinator.schemas.values()) registry.put(schema);
      await transactionDone(transaction);
      // A store may have registered while the request was settling. Re-open
      // once instead of exposing a connection missing that store.
      if (!databaseHasSchemas(database, coordinator)) {
        resetCoordinatorDatabase(coordinator, database);
        return openCoordinatedDatabase(coordinator);
      }
      return database;
    })
    .catch(async (error: unknown) => {
      coordinator.currentDatabase = null;
      coordinator.databasePromise = null;
      if (isRetryableIndexedDbRace(error) && retryAttempt < INDEXED_DB_RETRY_LIMIT) {
        await yieldForIndexedDbRetry(retryAttempt);
        return openCoordinatedDatabase(coordinator, retryAttempt + 1);
      }
      throw error;
    });
  coordinator.databasePromise = pending;
  return pending;
}

async function runWithCoordinatedDatabase<T>(
  coordinator: IndexedDbCoordinator,
  operation: (database: IDBDatabase) => Promise<T>,
  retryOperation = (_error: unknown): boolean => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= INDEXED_DB_RETRY_LIMIT; attempt += 1) {
    const database = await openCoordinatedDatabase(coordinator);
    try {
      return await operation(database);
    } catch (error) {
      if (
        !isRetryableIndexedDbRace(error) ||
        !retryOperation(error) ||
        attempt === INDEXED_DB_RETRY_LIMIT
      ) {
        throw error;
      }
      lastError = error;
      resetCoordinatorDatabase(coordinator, database);
      await yieldForIndexedDbRetry(attempt);
    }
  }
  throw lastError ?? new Error("IndexedDB schema coordination retry limit was reached.");
}

function stalePartitionError(): VoiceInputError {
  return new VoiceInputError(
    "submission-failed",
    "The durable audio partition changed before the operation could commit."
  );
}

function activeSendLeaseError(): VoiceInputError {
  return new VoiceInputError(
    "submission-failed",
    "Another browser instance is already sending this pending audio turn."
  );
}

function partitionValue(value: string): string {
  const partition = value.trim();
  if (!partition || partition.length > 256) {
    throw new TypeError("partition must be a non-empty opaque owner key.");
  }
  return partition;
}

function logicalStoreName(value: string): string {
  if (
    !value ||
    value.length > 128 ||
    value !== value.trim() ||
    value === STORE_REGISTRY_NAME ||
    value === LEGACY_DEFAULT_CONTROL_STORE_NAME ||
    value.startsWith(PARTITION_STORE_PREFIX)
  ) {
    throw new TypeError("storeName must be a non-empty, non-reserved logical store name.");
  }
  return value;
}

function epochFromRow(row: PartitionControlRow | undefined): number {
  const epoch = row?.epoch ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new VoiceInputError("submission-failed", "The durable partition epoch is invalid.");
  }
  return epoch;
}

function nextEpoch(epoch: number): number {
  if (epoch >= Number.MAX_SAFE_INTEGER) {
    throw new VoiceInputError("submission-failed", "The durable partition epoch cannot advance.");
  }
  return epoch + 1;
}

function validateDecodedRecord<StoredPayload>(
  row: StoredRow<StoredPayload>,
  record: DirectAudioOutboxRecord
): DirectAudioOutboxRecord {
  if (
    record.version !== 1 ||
    record.clientTurnId !== row.clientTurnId ||
    record.createdAt !== row.createdAt ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    !record.audio ||
    typeof record.audio.mimeType !== "string" ||
    !record.audio.mimeType.trim() ||
    typeof record.audio.durationMs !== "number" ||
    !Number.isFinite(record.audio.durationMs) ||
    record.audio.durationMs < 0 ||
    !Number.isSafeInteger(record.audio.size) ||
    record.audio.size <= 0 ||
    record.audio.blob?.size !== record.audio.size
  ) {
    throw new VoiceInputError(
      "submission-failed",
      "The persisted audio outbox record failed integrity validation."
    );
  }
  return record;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function controlGet(
  transaction: IDBTransaction,
  storeName: string,
  partition: string
): IDBRequest<PartitionControlRow | undefined> {
  return transaction.objectStore(storeName).get(partition) as IDBRequest<
    PartitionControlRow | undefined
  >;
}

function partitionRange(
  keyRange: Pick<typeof IDBKeyRange, "bound">,
  partition: string
): IDBKeyRange {
  return keyRange.bound([partition, ""], [partition, "\uffff"]);
}

async function readPartitionEpoch(
  database: IDBDatabase,
  controlStoreName: string,
  partition: string
): Promise<number> {
  const transaction = database.transaction(controlStoreName, "readonly");
  const row = await requestResult(controlGet(transaction, controlStoreName, partition));
  await transactionDone(transaction);
  return epochFromRow(row);
}

function casPut<StoredPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  partition: string;
  expectedEpoch: number;
  row: StoredRow<StoredPayload>;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = input.database.transaction(
      [input.storeName, input.controlStoreName],
      "readwrite"
    );
    let operationError: unknown = null;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(operationError ?? transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => {
      operationError ??= transaction.error;
    };
    const request = controlGet(transaction, input.controlStoreName, input.partition);
    request.onerror = () => {
      operationError = request.error;
    };
    request.onsuccess = () => {
      try {
        const currentEpoch = epochFromRow(request.result);
        if (currentEpoch !== input.expectedEpoch) throw stalePartitionError();
        if (!request.result) {
          transaction.objectStore(input.controlStoreName).add({
            partition: input.partition,
            epoch: currentEpoch
          } satisfies PartitionControlRow);
        }
        transaction.objectStore(input.storeName).add(input.row);
      } catch (error) {
        operationError = error;
        transaction.abort();
      }
    };
  });
}

function clearAndBump(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  partition: string;
  range: IDBKeyRange;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = input.database.transaction(
      [input.storeName, input.controlStoreName],
      "readwrite"
    );
    let operationError: unknown = null;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(operationError ?? transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => {
      operationError ??= transaction.error;
    };
    const controlRequest = controlGet(
      transaction,
      input.controlStoreName,
      input.partition
    );
    controlRequest.onerror = () => {
      operationError = controlRequest.error;
    };
    controlRequest.onsuccess = () => {
      try {
        transaction.objectStore(input.controlStoreName).put({
          partition: input.partition,
          epoch: nextEpoch(epochFromRow(controlRequest.result))
        } satisfies PartitionControlRow);
      } catch (error) {
        operationError = error;
        transaction.abort();
        return;
      }
      const cursorRequest = transaction.objectStore(input.storeName).openCursor(input.range);
      cursorRequest.onerror = () => {
        operationError = cursorRequest.error;
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    };
  });
}

async function readClaimSnapshot<StoredPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  sourcePartition: string;
  targetPartition: string;
  clientTurnId: string;
}): Promise<ClaimSnapshot<StoredPayload>> {
  const transaction = input.database.transaction(
    [input.storeName, input.controlStoreName],
    "readonly"
  );
  const sourceControl = requestResult(
    controlGet(transaction, input.controlStoreName, input.sourcePartition)
  );
  const targetControl = requestResult(
    controlGet(transaction, input.controlStoreName, input.targetPartition)
  );
  const row = requestResult(
    transaction
      .objectStore(input.storeName)
      .get([input.sourcePartition, input.clientTurnId])
  ) as Promise<StoredRow<StoredPayload> | undefined>;
  const [sourceRow, targetRow, storedRow] = await Promise.all([
    sourceControl,
    targetControl,
    row
  ]);
  await transactionDone(transaction);
  if (!storedRow) {
    throw new VoiceInputError("submission-failed", "The pending audio turn was not found.");
  }
  return {
    sourceEpoch: epochFromRow(sourceRow),
    targetEpoch: epochFromRow(targetRow),
    row: storedRow
  };
}

function casClaim<TargetPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  sourcePartition: string;
  targetPartition: string;
  expectedSourceEpoch: number;
  expectedTargetEpoch: number;
  sourceRow: StoredRow;
  targetRow: StoredRow<TargetPayload>;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new VoiceInputError("submission-failed", "The durable audio claim was cancelled.")
    );
  }
  return new Promise((resolve, reject) => {
    const transaction = input.database.transaction(
      [input.storeName, input.controlStoreName],
      "readwrite"
    );
    let operationError: unknown = null;
    const abortClaim = (): void => {
      operationError =
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new VoiceInputError("submission-failed", "The durable audio claim was cancelled.");
      try {
        transaction.abort();
      } catch {
        // The transaction already completed; its completion handler owns the result.
      }
    };
    const cleanupSignal = (): void =>
      input.signal?.removeEventListener("abort", abortClaim);
    input.signal?.addEventListener("abort", abortClaim, { once: true });
    transaction.oncomplete = () => {
      cleanupSignal();
      resolve();
    };
    transaction.onabort = () => {
      cleanupSignal();
      reject(operationError ?? transaction.error ?? new Error("IndexedDB transaction aborted."));
    };
    transaction.onerror = () => {
      operationError ??= transaction.error;
    };
    const sourceControl = controlGet(
      transaction,
      input.controlStoreName,
      input.sourcePartition
    );
    const targetControl = controlGet(
      transaction,
      input.controlStoreName,
      input.targetPartition
    );
    const sourceRow = transaction
      .objectStore(input.storeName)
      .get([input.sourcePartition, input.sourceRow.clientTurnId]) as IDBRequest<
      StoredRow | undefined
    >;
    let remaining = 3;
    const failRequest = (request: IDBRequest): void => {
      operationError = request.error;
    };
    sourceControl.onerror = () => failRequest(sourceControl);
    targetControl.onerror = () => failRequest(targetControl);
    sourceRow.onerror = () => failRequest(sourceRow);
    const finishRead = (): void => {
      remaining -= 1;
      if (remaining !== 0) return;
      try {
        if (input.signal?.aborted) {
          throw input.signal.reason instanceof Error
            ? input.signal.reason
            : new VoiceInputError("submission-failed", "The durable audio claim was cancelled.");
        }
        const currentSourceEpoch = epochFromRow(sourceControl.result);
        const currentTargetEpoch = epochFromRow(targetControl.result);
        const currentSourceRow = sourceRow.result;
        if (
          currentSourceEpoch !== input.expectedSourceEpoch ||
          currentTargetEpoch !== input.expectedTargetEpoch ||
          !currentSourceRow ||
          currentSourceRow.createdAt !== input.sourceRow.createdAt ||
          currentSourceRow.revision !== input.sourceRow.revision
        ) {
          throw stalePartitionError();
        }
        transaction.objectStore(input.controlStoreName).put({
          partition: input.sourcePartition,
          epoch: nextEpoch(currentSourceEpoch)
        } satisfies PartitionControlRow);
        transaction.objectStore(input.controlStoreName).put({
          partition: input.targetPartition,
          epoch: nextEpoch(currentTargetEpoch)
        } satisfies PartitionControlRow);
        transaction.objectStore(input.storeName).add(input.targetRow);
        transaction
          .objectStore(input.storeName)
          .delete([input.sourcePartition, input.sourceRow.clientTurnId]);
      } catch (error) {
        operationError = error;
        transaction.abort();
      }
    };
    sourceControl.onsuccess = finishRead;
    targetControl.onsuccess = finishRead;
    sourceRow.onsuccess = finishRead;
  });
}

async function readLeaseSnapshot<StoredPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  partition: string;
  clientTurnId: string;
}): Promise<{ epoch: number; row: StoredRow<StoredPayload> }> {
  const transaction = input.database.transaction(
    [input.storeName, input.controlStoreName],
    "readonly"
  );
  const [control, row] = await Promise.all([
    requestResult(controlGet(transaction, input.controlStoreName, input.partition)),
    requestResult(
      transaction.objectStore(input.storeName).get([input.partition, input.clientTurnId])
    ) as Promise<StoredRow<StoredPayload> | undefined>
  ]);
  await transactionDone(transaction);
  if (!row) {
    throw new VoiceInputError("submission-failed", "The pending audio turn was not found.");
  }
  return { epoch: epochFromRow(control), row };
}

function casAcquireSendLease<StoredPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  partition: string;
  snapshot: { epoch: number; row: StoredRow<StoredPayload> };
  now: number;
}): Promise<{ revision: string; token: string }> {
  return new Promise((resolve, reject) => {
    const transaction = input.database.transaction(
      [input.storeName, input.controlStoreName],
      "readwrite"
    );
    let operationError: unknown = null;
    let acquired: { revision: string; token: string } | null = null;
    transaction.oncomplete = () => {
      if (acquired) resolve(acquired);
      else reject(operationError ?? new Error("IndexedDB send lease was not acquired."));
    };
    transaction.onabort = () =>
      reject(operationError ?? transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => {
      operationError ??= transaction.error;
    };
    const control = controlGet(transaction, input.controlStoreName, input.partition);
    const rowRequest = transaction
      .objectStore(input.storeName)
      .get([input.partition, input.snapshot.row.clientTurnId]) as IDBRequest<
      StoredRow<StoredPayload> | undefined
    >;
    let remaining = 2;
    const failed = (request: IDBRequest): void => {
      operationError = request.error;
    };
    control.onerror = () => failed(control);
    rowRequest.onerror = () => failed(rowRequest);
    const finish = (): void => {
      remaining -= 1;
      if (remaining !== 0) return;
      try {
        const epoch = epochFromRow(control.result);
        const row = rowRequest.result;
        if (
          epoch !== input.snapshot.epoch ||
          !row ||
          row.createdAt !== input.snapshot.row.createdAt ||
          row.revision !== input.snapshot.row.revision
        ) {
          throw stalePartitionError();
        }
        if (row.sendLease && row.sendLease.expiresAt > input.now) {
          throw activeSendLeaseError();
        }
        const revision = row.revision ?? createStableClientTurnId();
        const token = createStableClientTurnId();
        const sendLease: StoredSendLease = {
          token,
          revision,
          partitionEpoch: epoch,
          expiresAt: input.now + SEND_LEASE_TTL_MS
        };
        transaction.objectStore(input.storeName).put({
          ...row,
          revision,
          sendLease
        } satisfies StoredRow<StoredPayload>);
        acquired = { revision, token };
      } catch (error) {
        operationError = error;
        transaction.abort();
      }
    };
    control.onsuccess = finish;
    rowRequest.onsuccess = finish;
  });
}

function mutateIfSendLease<StoredPayload>(input: {
  database: IDBDatabase;
  storeName: string;
  controlStoreName: string;
  partition: string;
  lease: DirectAudioOutboxSendLease;
  operation: "assert" | "delete" | "release";
  now: number;
}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = input.database.transaction(
      [input.storeName, input.controlStoreName],
      "readwrite"
    );
    let operationError: unknown = null;
    let matched = false;
    transaction.oncomplete = () => resolve(matched);
    transaction.onabort = () =>
      reject(operationError ?? transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => {
      operationError ??= transaction.error;
    };
    const control = controlGet(transaction, input.controlStoreName, input.partition);
    const rowRequest = transaction
      .objectStore(input.storeName)
      .get([input.partition, input.lease.clientTurnId]) as IDBRequest<
      StoredRow<StoredPayload> | undefined
    >;
    let remaining = 2;
    const failed = (request: IDBRequest): void => {
      operationError = request.error;
    };
    control.onerror = () => failed(control);
    rowRequest.onerror = () => failed(rowRequest);
    const finish = (): void => {
      remaining -= 1;
      if (remaining !== 0) return;
      try {
        const epoch = epochFromRow(control.result);
        const row = rowRequest.result;
        const lease = row?.sendLease;
        matched = Boolean(
          row &&
            epoch === input.lease.partitionEpoch &&
            row.revision === input.lease.revision &&
            lease?.token === input.lease.token &&
            lease.partitionEpoch === input.lease.partitionEpoch &&
            lease.revision === input.lease.revision &&
            (input.operation === "release" || lease.expiresAt > input.now)
        );
        if (!matched) {
          if (input.operation === "assert") throw stalePartitionError();
          return;
        }
        if (input.operation === "delete") {
          transaction
            .objectStore(input.storeName)
            .delete([input.partition, input.lease.clientTurnId]);
        } else if (input.operation === "release") {
          const { sendLease: _sendLease, ...released } = row!;
          transaction.objectStore(input.storeName).put(released);
        } else {
          transaction.objectStore(input.storeName).put({
            ...row!,
            sendLease: { ...lease!, expiresAt: input.now + SEND_LEASE_TTL_MS }
          });
        }
      } catch (error) {
        operationError = error;
        transaction.abort();
      }
    };
    control.onsuccess = finish;
    rowRequest.onsuccess = finish;
  });
}

export function createIndexedDbDirectAudioOutboxStore<StoredPayload>(
  options: IndexedDbDirectAudioOutboxOptions<StoredPayload>
): IndexedDbDirectAudioOutboxStore {
  const partition = partitionValue(options.partition);
  const databaseName = options.databaseName ?? "editable-voice-input-outbox-v1";
  const storeName = logicalStoreName(options.storeName ?? DEFAULT_STORE_NAME);
  const controlStoreName =
    storeName === DEFAULT_STORE_NAME
      ? LEGACY_DEFAULT_CONTROL_STORE_NAME
      : `${PARTITION_STORE_PREFIX}${encodeURIComponent(storeName)}`;
  const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  if (!keyRange) {
    throw new VoiceInputError("unsupported-browser", "IndexedDB key ranges are unavailable.");
  }
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new VoiceInputError("unsupported-browser", "IndexedDB is unavailable.");
  }
  const coordinator = getCoordinator(factory, databaseName);
  const existingRegistration = coordinator.schemas.get(storeName);
  if (
    existingRegistration &&
    existingRegistration.controlStoreName !== controlStoreName
  ) {
    throw schemaConflict(storeName);
  }
  coordinator.schemas.set(storeName, { storeName, controlStoreName });
  if (
    coordinator.currentDatabase &&
    (!coordinator.currentDatabase.objectStoreNames.contains(storeName) ||
      !coordinator.currentDatabase.objectStoreNames.contains(controlStoreName))
  ) {
    resetCoordinatorDatabase(coordinator, coordinator.currentDatabase);
  }
  const ownerRange = (value = partition): IDBKeyRange => partitionRange(keyRange, value);
  const withDatabase = <T>(
    operation: (database: IDBDatabase) => Promise<T>,
    retryOperation?: (error: unknown) => boolean
  ): Promise<T> =>
    retryOperation
      ? runWithCoordinatedDatabase(coordinator, operation, retryOperation)
      : runWithCoordinatedDatabase(coordinator, operation);

  return {
    partition,
    async getPartitionEpoch() {
      return withDatabase((database) =>
        readPartitionEpoch(database, controlStoreName, partition)
      );
    },
    async put(record) {
      const expectedEpoch = await withDatabase((database) =>
        readPartitionEpoch(database, controlStoreName, partition)
      );
      const payload = await options.codec.encode(record);
      const row = {
        partition,
        clientTurnId: record.clientTurnId,
        createdAt: record.createdAt,
        revision: createStableClientTurnId(),
        payload
      };
      await withDatabase((database) =>
        casPut({
          database,
          storeName,
          controlStoreName,
          partition,
          expectedEpoch,
          row
        })
      );
    },
    async get(clientTurnId) {
      const row = await withDatabase(async (database) => {
        const transaction = database.transaction(storeName, "readonly");
        const stored = (await requestResult(
          transaction.objectStore(storeName).get([partition, clientTurnId])
        )) as StoredRow<StoredPayload> | undefined;
        await transactionDone(transaction);
        return stored;
      });
      return row
        ? validateDecodedRecord(row, await options.codec.decode(row.payload))
        : null;
    },
    async list() {
      const rows = await withDatabase(async (database) => {
        const transaction = database.transaction(storeName, "readonly");
        const stored = (await requestResult(
          transaction.objectStore(storeName).getAll(ownerRange())
        )) as StoredRow<StoredPayload>[];
        await transactionDone(transaction);
        return stored;
      });
      rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return Promise.all(
        rows.map(async (row) =>
          validateDecodedRecord(row, await options.codec.decode(row.payload))
        )
      );
    },
    async delete(clientTurnId) {
      await withDatabase(async (database) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete([partition, clientTurnId]);
        await transactionDone(transaction);
      });
    },
    async clear() {
      await withDatabase((database) =>
        clearAndBump({
          database,
          storeName,
          controlStoreName,
          partition,
          range: ownerRange()
        })
      );
    },
    async acquireSendLease(clientTurnId) {
      const snapshot = await withDatabase((database) =>
        readLeaseSnapshot<StoredPayload>({
          database,
          storeName,
          controlStoreName,
          partition,
          clientTurnId
        })
      );
      const record = validateDecodedRecord(
        snapshot.row,
        await options.codec.decode(snapshot.row.payload)
      );
      const acquired = await withDatabase((database) =>
        casAcquireSendLease({
          database,
          storeName,
          controlStoreName,
          partition,
          snapshot,
          now: Date.now()
        })
      );
      return {
        clientTurnId,
        revision: acquired.revision,
        partitionEpoch: snapshot.epoch,
        token: acquired.token,
        record
      };
    },
    async assertSendLease(lease) {
      await withDatabase((database) =>
        mutateIfSendLease<StoredPayload>({
          database,
          storeName,
          controlStoreName,
          partition,
          lease,
          operation: "assert",
          now: Date.now()
        })
      );
    },
    async deleteIfSendLease(lease) {
      return withDatabase((database) =>
        mutateIfSendLease<StoredPayload>({
          database,
          storeName,
          controlStoreName,
          partition,
          lease,
          operation: "delete",
          now: Date.now()
        })
      );
    },
    async releaseSendLease(lease) {
      await withDatabase((database) =>
        mutateIfSendLease<StoredPayload>({
          database,
          storeName,
          controlStoreName,
          partition,
          lease,
          operation: "release",
          now: Date.now()
        })
      );
    },
    async claimTo(input) {
      const targetPartition = partitionValue(input.targetPartition);
      if (targetPartition === partition) {
        throw new TypeError("targetPartition must differ from the source partition.");
      }
      const snapshot = await withDatabase((database) =>
        readClaimSnapshot<StoredPayload>({
          database,
          storeName,
          controlStoreName,
          sourcePartition: partition,
          targetPartition,
          clientTurnId: input.clientTurnId
        })
      );
      const sourceRecord = validateDecodedRecord(
        snapshot.row,
        await options.codec.decode(snapshot.row.payload)
      );
      const targetRecord = input.transform(sourceRecord);
      validateDecodedRecord(
        {
          partition: targetPartition,
          clientTurnId: sourceRecord.clientTurnId,
          createdAt: sourceRecord.createdAt,
          payload: null
        },
        targetRecord
      );
      const targetPayload = await input.targetCodec.encode(targetRecord);
      const targetRow = {
        partition: targetPartition,
        clientTurnId: targetRecord.clientTurnId,
        createdAt: targetRecord.createdAt,
        revision: createStableClientTurnId(),
        payload: targetPayload
      };
      await withDatabase((database) =>
        casClaim({
          database,
          storeName,
          controlStoreName,
          sourcePartition: partition,
          targetPartition,
          expectedSourceEpoch: snapshot.sourceEpoch,
          expectedTargetEpoch: snapshot.targetEpoch,
          sourceRow: snapshot.row,
          targetRow,
          ...(input.signal ? { signal: input.signal } : {})
        }),
        () => !input.signal?.aborted
      );
      return targetRecord;
    }
  };
}
