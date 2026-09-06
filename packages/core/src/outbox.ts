import {
  uploadDirectAudioMessage,
  validateDirectAudioMessage,
  type DirectAudioMessage,
  type DirectAudioUploadTransport
} from "./direct-audio";
import { VoiceInputError, type CapturedAudio } from "./types";

export interface DirectAudioOutboxRecord {
  version: 1;
  /** Stable across retries, refresh recovery, and response-loss reconciliation. */
  clientTurnId: string;
  createdAt: string;
  audio: CapturedAudio;
  metadata?: Readonly<Record<string, string>>;
}

export interface DirectAudioOutboxStore {
  /** Must not overwrite an existing row with the same clientTurnId. */
  put(record: DirectAudioOutboxRecord): Promise<void>;
  get(clientTurnId: string): Promise<DirectAudioOutboxRecord | null>;
  list(): Promise<readonly DirectAudioOutboxRecord[]>;
  delete(clientTurnId: string): Promise<void>;
  /** Clears persisted rows without decoding them, for explicit account transitions. */
  clear(): Promise<void>;
  /**
   * Optional durable cross-instance fence. Stores that implement this contract
   * prevent a sender in another tab from continuing after clear/claim/rewrite.
   */
  acquireSendLease?(clientTurnId: string): Promise<DirectAudioOutboxSendLease>;
  assertSendLease?(lease: DirectAudioOutboxSendLease): Promise<void>;
  deleteIfSendLease?(lease: DirectAudioOutboxSendLease): Promise<boolean>;
  releaseSendLease?(lease: DirectAudioOutboxSendLease): Promise<void>;
}

export interface DirectAudioOutboxSendLease {
  clientTurnId: string;
  /** Opaque row revision; changes whenever a record is re-keyed or replaced. */
  revision: string;
  /** Durable owner-partition generation captured when the lease is acquired. */
  partitionEpoch: number;
  /** Opaque, per-attempt token persisted with the row. */
  token: string;
  record: DirectAudioOutboxRecord;
}

export interface DirectAudioLookupInput {
  clientMessageId: string;
  metadata?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface DirectAudioReconciliationAttempt extends DirectAudioUploadTransport {
  find(input: DirectAudioLookupInput): Promise<DirectAudioMessage | null>;
}

/** The lookup must be exact and owner-authorized; 404 should map to `null`. */
export interface ReconciliableDirectAudioTransport extends DirectAudioReconciliationAttempt {
  /** Capture an immutable identity/conversation scope for this find→upload attempt. */
  beginAttempt?(input: {
    clientTurnId: string;
    metadata?: Readonly<Record<string, string>>;
  }): DirectAudioReconciliationAttempt;
  /** Add product-specific opaque scope before the record is encrypted by its store codec. */
  prepareMetadata?(
    metadata?: Readonly<Record<string, string>>
  ): Readonly<Record<string, string>> | undefined;
}

export interface DirectAudioOutboxOptions {
  store: DirectAudioOutboxStore;
  transport: ReconciliableDirectAudioTransport;
  createClientTurnId?: () => string;
  now?: () => Date;
}

export interface StageDirectAudioInput {
  audio: CapturedAudio;
  clientTurnId?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface SendDirectAudioOutboxOptions {
  signal?: AbortSignal;
}

export interface DirectAudioOutboxSendResult {
  message: DirectAudioMessage;
  recoveredFromServer: boolean;
  /** True when the server accepted the turn but local CAS cleanup must retry later. */
  cleanupPending?: boolean;
}

export function createStableClientTurnId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  throw new VoiceInputError(
    "unsupported-browser",
    "Secure random IDs are unavailable in this environment."
  );
}

function assertClientTurnId(value: string): void {
  if (!value.trim() || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new VoiceInputError("submission-failed", "A valid clientTurnId is required.");
  }
}

function assertCapturedAudio(audio: CapturedAudio): void {
  if (
    !audio ||
    typeof audio.mimeType !== "string" ||
    !audio.mimeType.trim() ||
    typeof audio.durationMs !== "number" ||
    !Number.isFinite(audio.durationMs) ||
    audio.durationMs < 0 ||
    !Number.isSafeInteger(audio.size) ||
    audio.size <= 0 ||
    audio.blob?.size !== audio.size
  ) {
    throw new VoiceInputError("submission-failed", "Captured audio is invalid.");
  }
}

/**
 * Product-neutral durable-send state machine. Durability and encryption are
 * supplied by the store; product/session fields belong in a separate adapter.
 */
export class DirectAudioOutbox {
  private readonly options: DirectAudioOutboxOptions;
  private readonly inFlight = new Map<string, Promise<DirectAudioOutboxSendResult>>();
  private readonly activeControllers = new Set<AbortController>();
  private generation = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: DirectAudioOutboxOptions) {
    this.options = options;
  }

  async stage(input: StageDirectAudioInput): Promise<DirectAudioOutboxRecord> {
    const generation = this.generation;
    assertCapturedAudio(input.audio);
    const clientTurnId = input.clientTurnId ??
      (this.options.createClientTurnId ?? createStableClientTurnId)();
    assertClientTurnId(clientTurnId);
    const metadata = this.options.transport.prepareMetadata?.(input.metadata) ?? input.metadata;
    const record: DirectAudioOutboxRecord = {
      version: 1,
      clientTurnId,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
      audio: input.audio,
      ...(metadata ? { metadata } : {})
    };
    return this.enqueueMutation(async () => {
      this.assertActive(generation);
      try {
        await this.options.store.put(record);
        this.assertActive(generation);
        return record;
      } catch (error) {
        this.assertActive(generation);
        const existing = await this.options.store.get(clientTurnId);
        this.assertActive(generation);
        if (existing) return existing;
        throw error;
      }
    });
  }

  async send(
    recordOrClientTurnId: DirectAudioOutboxRecord | string,
    options: SendDirectAudioOutboxOptions = {}
  ): Promise<DirectAudioOutboxSendResult> {
    return this.sendAtGeneration(recordOrClientTurnId, options, this.generation);
  }

  private async sendAtGeneration(
    recordOrClientTurnId: DirectAudioOutboxRecord | string,
    options: SendDirectAudioOutboxOptions,
    generation: number
  ): Promise<DirectAudioOutboxSendResult> {
    const clientTurnId =
      typeof recordOrClientTurnId === "string"
        ? recordOrClientTurnId
        : recordOrClientTurnId.clientTurnId;
    assertClientTurnId(clientTurnId);
    this.assertActive(generation, options.signal);
    const active = this.inFlight.get(clientTurnId);
    if (active) return active;
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    this.activeControllers.add(controller);
    const operation = this.sendOnce(
      recordOrClientTurnId,
      { signal: controller.signal },
      generation
    ).finally(() => {
      options.signal?.removeEventListener("abort", abortFromCaller);
      this.activeControllers.delete(controller);
      if (this.inFlight.get(clientTurnId) === operation) this.inFlight.delete(clientTurnId);
    });
    this.inFlight.set(clientTurnId, operation);
    return operation;
  }

  async recoverAll(
    options: SendDirectAudioOutboxOptions = {}
  ): Promise<readonly DirectAudioOutboxSendResult[]> {
    const generation = this.generation;
    const pending = await this.options.store.list();
    this.assertActive(generation, options.signal);
    return Promise.all(
      pending.map((record) => this.sendAtGeneration(record, options, generation))
    );
  }

  async discard(clientTurnId: string): Promise<void> {
    const generation = this.generation;
    assertClientTurnId(clientTurnId);
    await this.enqueueMutation(async () => {
      this.assertActive(generation);
      await this.options.store.delete(clientTurnId);
      this.assertActive(generation);
    });
  }

  async clear(): Promise<void> {
    this.generation += 1;
    for (const controller of this.activeControllers) {
      controller.abort(new Error("The audio outbox was cleared."));
    }
    this.inFlight.clear();
    await this.enqueueMutation(async () => {
      await this.options.store.clear();
    });
  }

  private async sendOnce(
    recordOrClientTurnId: DirectAudioOutboxRecord | string,
    options: SendDirectAudioOutboxOptions,
    generation: number
  ): Promise<DirectAudioOutboxSendResult> {
    const clientTurnId =
      typeof recordOrClientTurnId === "string"
        ? recordOrClientTurnId
        : recordOrClientTurnId.clientTurnId;
    // Always cross the store/codec boundary, even when the caller retained the
    // staged object. Durable stores additionally persist a partition/revision
    // lease so another instance can invalidate this sender with clear/claim.
    this.assertActive(generation, options.signal);
    const lease = await this.options.store.acquireSendLease?.(clientTurnId);
    const record = lease?.record ?? (await this.options.store.get(clientTurnId));
    this.assertActive(generation, options.signal);
    if (!record) {
      throw new VoiceInputError("submission-failed", "The pending audio turn was not found.");
    }
    const transport =
      this.options.transport.beginAttempt?.({
        clientTurnId: record.clientTurnId,
        ...(record.metadata ? { metadata: record.metadata } : {})
      }) ?? this.options.transport;
    try {
      await this.assertLeaseActive(lease, generation, options.signal);
      const lookup = await transport.find({
        clientMessageId: record.clientTurnId,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
      await this.assertLeaseActive(lease, generation, options.signal);
      if (lookup) {
        const message = validateDirectAudioMessage(lookup, record.clientTurnId);
        const cleanupPending = !(await this.cleanupAfterServerReceipt(
          record.clientTurnId,
          lease
        ));
        if (cleanupPending && lease) {
          // A failed/aborted conditional delete leaves the row as a durable
          // receipt candidate. Release its lease immediately so recovery does
          // not have to wait for the lease TTL before reconciling again.
          await this.options.store.releaseSendLease?.(lease).catch(() => undefined);
        }
        return {
          message,
          recoveredFromServer: true,
          ...(cleanupPending ? { cleanupPending: true } : {})
        };
      }

      // This is the last client-side fence before upload. Product adapters must
      // also make owner+identityEpoch an atomic server-side upload precondition;
      // AbortSignal alone cannot close the final network delivery race.
      await this.assertLeaseActive(lease, generation, options.signal);
      const message = await uploadDirectAudioMessage(transport, {
        clientMessageId: record.clientTurnId,
        audio: record.audio,
        ...(record.metadata ? { metadata: record.metadata } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
      // A validated server response is a durable receipt. Never turn success
      // into failure merely because clear/abort raced with local CAS cleanup.
      const cleanupPending = !(await this.cleanupAfterServerReceipt(
        record.clientTurnId,
        lease
      ));
      if (cleanupPending && lease) {
        await this.options.store.releaseSendLease?.(lease).catch(() => undefined);
      }
      return {
        message,
        recoveredFromServer: false,
        ...(cleanupPending ? { cleanupPending: true } : {})
      };
    } catch (error) {
      if (lease) {
        await this.options.store.releaseSendLease?.(lease).catch(() => undefined);
      }
      throw error;
    }
  }

  private async assertLeaseActive(
    lease: DirectAudioOutboxSendLease | undefined,
    generation: number,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertActive(generation, signal);
    if (lease) await this.options.store.assertSendLease?.(lease);
    this.assertActive(generation, signal);
  }

  private async cleanupAfterServerReceipt(
    clientTurnId: string,
    lease?: DirectAudioOutboxSendLease
  ): Promise<boolean> {
    try {
      return await this.enqueueMutation(async () => {
        if (lease && this.options.store.deleteIfSendLease) {
          return this.options.store.deleteIfSendLease(lease);
        }
        await this.options.store.delete(clientTurnId);
        return true;
      });
    } catch {
      // The pending row remains a durable receipt candidate. A later recovery
      // finds the server message and retries conditional cleanup.
      return false;
    }
  }

  private assertActive(generation: number, signal?: AbortSignal): void {
    if (generation === this.generation && !signal?.aborted) return;
    throw new VoiceInputError(
      "submission-failed",
      "The pending audio operation was invalidated before it completed.",
      { cause: signal?.reason }
    );
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.then(operation, operation);
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }
}

/** In-memory reference store for tests and demos. It is intentionally not durable. */
export function createMemoryDirectAudioOutboxStore(): DirectAudioOutboxStore {
  const records = new Map<string, DirectAudioOutboxRecord>();
  return {
    async put(record) {
      if (records.has(record.clientTurnId)) {
        throw new VoiceInputError("submission-failed", "The audio turn is already staged.");
      }
      records.set(record.clientTurnId, record);
    },
    async get(clientTurnId) {
      return records.get(clientTurnId) ?? null;
    },
    async list() {
      return [...records.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );
    },
    async delete(clientTurnId) {
      records.delete(clientTurnId);
    },
    async clear() {
      records.clear();
    }
  };
}
