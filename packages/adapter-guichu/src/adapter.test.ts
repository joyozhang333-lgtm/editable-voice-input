import { describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  DirectAudioOutbox,
  createIndexedDbDirectAudioOutboxStore,
  createMemoryDirectAudioOutboxStore
} from "@editable-voice-input/core";
import {
  claimGuichuIndexedDbOutboxRecord,
  createGuichuOutboxMetadata,
  createGuichuVoiceTransport,
  createGuichuOutboxCodec
} from "./index";

const context = {
  conversationId: "conversation-synthetic-1",
  sessionId: "session-synthetic-1",
  ownerKey: "guest-synthetic-1",
  identityEpoch: 1
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("GuiChu adapter", () => {
  it("keeps product context in the adapter and performs exact lookup", async () => {
    const findExact = vi.fn(async () => null);
    const transport = createGuichuVoiceTransport({
      context: () => context,
      api: { findExact, upload: vi.fn() }
    });
    await expect(transport.find({ clientMessageId: "turn-synthetic-1" })).resolves.toBeNull();
    expect(findExact).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, clientTurnId: "turn-synthetic-1" })
    );
  });

  it("invalidates an attempt when identity changes during exact lookup", async () => {
    let current = context;
    const findExact = vi.fn(async () => {
      current = { ...context, identityEpoch: 2 };
      return null;
    });
    const upload = vi.fn(async ({ clientTurnId }) => ({
      voiceMessageId: "voice-synthetic-1",
      clientTurnId,
      createdAt: "2026-01-01T00:00:00.000Z",
      playbackUrl: "/api/voice/messages/voice-synthetic-1/audio",
      mimeType: "audio/webm",
      durationMs: 500,
      size: 5
    }));
    const transport = createGuichuVoiceTransport({
      context: () => current,
      api: { findExact, upload }
    });
    const attempt = transport.beginAttempt!({
      clientTurnId: "turn-synthetic-1",
      metadata: createGuichuOutboxMetadata(context)
    });
    await expect(
      attempt.find({ clientMessageId: "turn-synthetic-1" })
    ).rejects.toThrow(/identity changed/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("runs the optional server identity preflight before find and upload", async () => {
    const assertIdentityCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stale server identity fence"));
    const upload = vi.fn();
    const transport = createGuichuVoiceTransport({
      context: () => context,
      api: {
        assertIdentityCurrent,
        findExact: vi.fn(async () => null),
        upload
      }
    });
    const outbox = new DirectAudioOutbox({
      store: createMemoryDirectAudioOutboxStore(),
      transport
    });
    await outbox.stage({
      clientTurnId: "turn-server-identity-preflight",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });

    await expect(outbox.send("turn-server-identity-preflight")).rejects.toThrow(
      /stale server identity fence/i
    );
    expect(assertIdentityCurrent).toHaveBeenCalledTimes(2);
    expect(assertIdentityCurrent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ownerKey: context.ownerKey,
        identityEpoch: context.identityEpoch,
        signal: expect.any(AbortSignal)
      })
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("persists the original conversation scope for response-loss reconciliation", async () => {
    let current = context;
    const findExact = vi.fn(async () => null);
    const upload = vi.fn(async ({ clientTurnId }) => ({
      voiceMessageId: "voice-synthetic-2",
      clientTurnId,
      createdAt: "2026-01-01T00:00:00.000Z",
      playbackUrl: "/api/voice/messages/voice-synthetic-2/audio",
      mimeType: "audio/webm",
      durationMs: 500,
      size: 5
    }));
    const transport = createGuichuVoiceTransport({
      context: () => current,
      api: { findExact, upload }
    });
    const outbox = new DirectAudioOutbox({
      store: createMemoryDirectAudioOutboxStore(),
      transport
    });
    const record = await outbox.stage({
      clientTurnId: "turn-synthetic-2",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });
    current = {
      ownerKey: context.ownerKey,
      conversationId: "conversation-synthetic-2",
      sessionId: "session-synthetic-2",
      identityEpoch: context.identityEpoch
    };
    await outbox.send(record);
    expect(findExact).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: context.conversationId,
        sessionId: context.sessionId,
        ownerKey: context.ownerKey
      })
    );
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: context.conversationId,
        sessionId: context.sessionId,
        ownerKey: context.ownerKey
      })
    );
  });

  it("rejects an owner switch between outbox decode and transport attempt", async () => {
    let current = context;
    const upload = vi.fn();
    const transport = createGuichuVoiceTransport({
      context: () => current,
      api: { findExact: vi.fn(async () => null), upload }
    });
    const outbox = new DirectAudioOutbox({
      store: createMemoryDirectAudioOutboxStore(),
      transport
    });
    const record = await outbox.stage({
      clientTurnId: "turn-synthetic-owner-switch",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });
    current = { ...context, ownerKey: "account-synthetic-2" };
    await expect(outbox.send(record)).rejects.toThrow(/different GuiChu owner/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a same-owner epoch transition between durable decode and beginAttempt", async () => {
    let current = context;
    const backing = createMemoryDirectAudioOutboxStore();
    const store = {
      ...backing,
      async get(clientTurnId: string) {
        const record = await backing.get(clientTurnId);
        current = { ...context, identityEpoch: 2 };
        return record;
      }
    };
    const upload = vi.fn();
    const outbox = new DirectAudioOutbox({
      store,
      transport: createGuichuVoiceTransport({
        context: () => current,
        api: { findExact: vi.fn(async () => null), upload }
      })
    });
    await outbox.stage({
      clientTurnId: "turn-synthetic-epoch-switch",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });

    await expect(outbox.send("turn-synthetic-epoch-switch")).rejects.toThrow(
      /stale GuiChu identity epoch/i
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("aborts exact lookup when the host invalidates the identity epoch", async () => {
    let identityEpoch = 1;
    let identityController = new AbortController();
    let lookupSignal: AbortSignal | undefined;
    const findExact = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<null>((_resolve, reject) => {
          lookupSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const upload = vi.fn();
    const transport = createGuichuVoiceTransport({
      context: () => ({ ...context, identityEpoch, identitySignal: identityController.signal }),
      api: { findExact, upload }
    });
    const attempt = transport.beginAttempt!({
      clientTurnId: "turn-identity-abort",
      metadata: createGuichuOutboxMetadata(context)
    });
    const finding = attempt.find({ clientMessageId: "turn-identity-abort" });
    await vi.waitFor(() => expect(lookupSignal).toBeDefined());
    identityEpoch = 2;
    identityController.abort(new Error("synthetic identity transition"));

    await expect(finding).rejects.toThrow(/identity changed/i);
    expect(lookupSignal?.aborted).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it("durably re-keys a claimed turn without leaving a guest copy", async () => {
    const indexedDB = new IDBFactory();
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const codec = (prefix: string) => ({
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        const token = `${prefix}:${record.clientTurnId}`;
        records.set(token, record);
        return token;
      },
      async decode(token: string) {
        if (!token.startsWith(`${prefix}:`)) throw new Error("foreign identity payload");
        const record = records.get(token);
        if (!record) throw new Error("missing synthetic payload");
        return record;
      }
    });
    const source = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName: "synthetic-guichu-durable-claim",
      partition: "opaque-guest-partition",
      codec: codec("guest")
    });
    const target = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName: "synthetic-guichu-durable-claim",
      partition: "opaque-account-partition",
      codec: codec("account")
    });
    const outbox = new DirectAudioOutbox({
      store: source,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await outbox.stage({
      clientTurnId: "turn-durable-claim",
      metadata: createGuichuOutboxMetadata(context, { synthetic: "true" }),
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });

    const targetContext = {
      ...context,
      ownerKey: "account-synthetic-2",
      identityEpoch: 2
    };
    const claimOrReconcile = vi.fn(async ({ clientTurnId }) => ({
      version: 1 as const,
      receiptId: "claim-receipt-synthetic-1",
      clientTurnId,
      sourceConversationId: context.conversationId,
      sourceSessionId: context.sessionId,
      sourceOwnerKey: context.ownerKey,
      sourceIdentityEpoch: "number:1",
      targetConversationId: targetContext.conversationId,
      targetSessionId: targetContext.sessionId,
      targetOwnerKey: targetContext.ownerKey,
      targetIdentityEpoch: "number:2",
      disposition: "reserved" as const
    }));
    await claimGuichuIndexedDbOutboxRecord({
      store: source,
      clientTurnId: "turn-durable-claim",
      targetPartition: "opaque-account-partition",
      targetCodec: codec("account"),
      sourceContext: context,
      targetContext,
      api: { claimOrReconcile }
    });

    expect(claimOrReconcile).toHaveBeenCalledOnce();
    expect(await source.list()).toEqual([]);
    expect(await target.list()).toEqual([
      expect.objectContaining({
        clientTurnId: "turn-durable-claim",
        metadata: expect.objectContaining({
          "guichu.ownerKey": "account-synthetic-2",
          "guichu.identityEpoch": "number:2",
          "guichu.claimReceiptId": "claim-receipt-synthetic-1"
        })
      })
    ]);
  });

  it("fences a claim when either identity aborts before, during, or after server reconciliation", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-guichu-identity-abort-claim";
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    let targetEncodeGate:
      | { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }
      | undefined;
    const codec = (prefix: string) => ({
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        if (prefix === "account" && targetEncodeGate) {
          targetEncodeGate.started.resolve();
          await targetEncodeGate.release.promise;
        }
        const token = `${prefix}:${record.clientTurnId}`;
        records.set(token, record);
        return token;
      },
      async decode(token: string) {
        const record = records.get(token);
        if (!record) throw new Error("missing identity-abort claim payload");
        return record;
      }
    });
    const source = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-identity-abort-guest",
      codec: codec("guest")
    });
    const target = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-identity-abort-account",
      codec: codec("account")
    });
    await new DirectAudioOutbox({
      store: source,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    }).stage({
      clientTurnId: "turn-identity-abort-claim",
      metadata: createGuichuOutboxMetadata(context),
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });
    const targetBase = {
      ...context,
      ownerKey: "account-identity-abort",
      identityEpoch: 2
    };
    const receipt = {
      version: 1 as const,
      receiptId: "claim-receipt-identity-abort",
      clientTurnId: "turn-identity-abort-claim",
      sourceConversationId: context.conversationId,
      sourceSessionId: context.sessionId,
      sourceOwnerKey: context.ownerKey,
      sourceIdentityEpoch: "number:1",
      targetConversationId: targetBase.conversationId,
      targetSessionId: targetBase.sessionId,
      targetOwnerKey: targetBase.ownerKey,
      targetIdentityEpoch: "number:2",
      disposition: "reserved" as const
    };
    const claim = (
      sourceSignal: AbortSignal,
      targetSignal: AbortSignal,
      claimOrReconcile: Parameters<typeof claimGuichuIndexedDbOutboxRecord>[0]["api"]["claimOrReconcile"]
    ) =>
      claimGuichuIndexedDbOutboxRecord({
        store: source,
        clientTurnId: "turn-identity-abort-claim",
        targetPartition: "opaque-identity-abort-account",
        targetCodec: codec("account"),
        sourceContext: { ...context, identitySignal: sourceSignal },
        targetContext: { ...targetBase, identitySignal: targetSignal },
        api: { claimOrReconcile }
      });

    const alreadyStale = new AbortController();
    alreadyStale.abort(new Error("synthetic pre-server identity abort"));
    const untouchedTarget = new AbortController();
    const preServerApi = vi.fn(async () => receipt);
    await expect(
      claim(alreadyStale.signal, untouchedTarget.signal, preServerApi)
    ).rejects.toThrow(/pre-server identity abort/i);
    expect(preServerApi).not.toHaveBeenCalled();

    const sourceDuringServer = new AbortController();
    const targetDuringServer = new AbortController();
    const serverResponse = deferred<typeof receipt>();
    let serverSignal: AbortSignal | undefined;
    const waitingApi = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      serverSignal = signal;
      return serverResponse.promise;
    });
    const waitingClaim = claim(
      sourceDuringServer.signal,
      targetDuringServer.signal,
      waitingApi
    );
    await vi.waitFor(() => expect(serverSignal).toBeDefined());
    targetDuringServer.abort(new Error("synthetic in-flight target identity abort"));
    await expect(waitingClaim).rejects.toThrow(/in-flight target identity abort/i);
    expect(serverSignal?.aborted).toBe(true);
    serverResponse.resolve(receipt);
    await Promise.resolve();

    const sourceDuringMove = new AbortController();
    const targetDuringMove = new AbortController();
    targetEncodeGate = { started: deferred<void>(), release: deferred<void>() };
    const movingClaim = claim(
      sourceDuringMove.signal,
      targetDuringMove.signal,
      vi.fn(async () => receipt)
    );
    await targetEncodeGate.started.promise;
    sourceDuringMove.abort(new Error("synthetic local-move identity abort"));
    targetEncodeGate.release.resolve();
    await expect(movingClaim).rejects.toThrow(/local-move identity abort/i);

    expect((await source.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-identity-abort-claim"
    ]);
    expect(await target.list()).toEqual([]);
  });

  it("retries an idempotent server claim after response loss before moving locally", async () => {
    const indexedDB = new IDBFactory();
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const codec = (prefix: string) => ({
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        const token = `${prefix}:${record.clientTurnId}`;
        records.set(token, record);
        return token;
      },
      async decode(token: string) {
        const record = records.get(token);
        if (!record) throw new Error("missing claim-response-loss payload");
        return record;
      }
    });
    const databaseName = "synthetic-guichu-claim-response-loss";
    const source = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-guest-response-loss",
      codec: codec("guest")
    });
    const target = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-account-response-loss",
      codec: codec("account")
    });
    const outbox = new DirectAudioOutbox({
      store: source,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await outbox.stage({
      clientTurnId: "turn-claim-response-loss",
      metadata: createGuichuOutboxMetadata(context),
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });
    const targetContext = {
      ...context,
      ownerKey: "account-synthetic-response-loss",
      identityEpoch: 2
    };
    const receipt = {
      version: 1 as const,
      receiptId: "claim-receipt-response-loss",
      clientTurnId: "turn-claim-response-loss",
      sourceConversationId: context.conversationId,
      sourceSessionId: context.sessionId,
      sourceOwnerKey: context.ownerKey,
      sourceIdentityEpoch: "number:1",
      targetConversationId: targetContext.conversationId,
      targetSessionId: targetContext.sessionId,
      targetOwnerKey: targetContext.ownerKey,
      targetIdentityEpoch: "number:2",
      disposition: "reconciled" as const
    };
    let committedReceipt = false;
    const claimOrReconcile = vi.fn(async () => {
      if (!committedReceipt) {
        committedReceipt = true;
        throw new TypeError("synthetic response lost after atomic server commit");
      }
      return receipt;
    });
    const claim = () =>
      claimGuichuIndexedDbOutboxRecord({
        store: source,
        clientTurnId: "turn-claim-response-loss",
        targetPartition: "opaque-account-response-loss",
        targetCodec: codec("account"),
        sourceContext: context,
        targetContext,
        api: { claimOrReconcile }
      });

    await expect(claim()).rejects.toThrow(/response lost/i);
    expect((await source.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-claim-response-loss"
    ]);
    expect(await target.list()).toEqual([]);

    await expect(claim()).resolves.toMatchObject({
      receipt: { receiptId: "claim-receipt-response-loss" },
      record: {
        metadata: expect.objectContaining({
          "guichu.claimReceiptId": "claim-receipt-response-loss",
          "guichu.ownerKey": targetContext.ownerKey
        })
      }
    });
    expect(claimOrReconcile).toHaveBeenCalledTimes(2);
    expect(await source.list()).toEqual([]);
    expect((await target.list())[0]?.clientTurnId).toBe("turn-claim-response-loss");
  });

  it("fails closed before server claim when legacy pending audio has no GuiChu scope", async () => {
    const source = createMemoryDirectAudioOutboxStore();
    await source.put({
      version: 1,
      clientTurnId: "turn-legacy-unscoped",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });
    const claimOrReconcile = vi.fn();

    await expect(
      claimGuichuIndexedDbOutboxRecord({
        store: source as never,
        clientTurnId: "turn-legacy-unscoped",
        targetPartition: "opaque-account-legacy",
        targetCodec: { encode: vi.fn(), decode: vi.fn() },
        sourceContext: context,
        targetContext: { ...context, ownerKey: "account-legacy", identityEpoch: 2 },
        api: { claimOrReconcile }
      })
    ).rejects.toThrow(/missing its sealed GuiChu/i);
    expect(claimOrReconcile).not.toHaveBeenCalled();
  });

  it("keeps the guest row when the server claim receipt does not match", async () => {
    const indexedDB = new IDBFactory();
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const codec = {
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        records.set(record.clientTurnId, record);
        return record.clientTurnId;
      },
      async decode(token: string) {
        const record = records.get(token);
        if (!record) throw new Error("missing invalid-receipt payload");
        return record;
      }
    };
    const source = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName: "synthetic-invalid-server-claim-receipt",
      partition: "opaque-invalid-receipt-guest",
      codec
    });
    const outbox = new DirectAudioOutbox({
      store: source,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await outbox.stage({
      clientTurnId: "turn-invalid-claim-receipt",
      metadata: createGuichuOutboxMetadata(context),
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });

    await expect(
      claimGuichuIndexedDbOutboxRecord({
        store: source,
        clientTurnId: "turn-invalid-claim-receipt",
        targetPartition: "opaque-invalid-receipt-account",
        targetCodec: codec,
        sourceContext: context,
        targetContext: { ...context, ownerKey: "account-invalid-receipt", identityEpoch: 2 },
        api: {
          claimOrReconcile: vi.fn(async () => ({
            version: 1 as const,
            receiptId: "mismatched-receipt",
            clientTurnId: "turn-invalid-claim-receipt",
            sourceConversationId: context.conversationId,
            sourceSessionId: "some-other-session",
            sourceOwnerKey: context.ownerKey,
            sourceIdentityEpoch: "number:1",
            targetConversationId: context.conversationId,
            targetSessionId: context.sessionId,
            targetOwnerKey: "account-invalid-receipt",
            targetIdentityEpoch: "number:2",
            disposition: "reserved" as const
          }))
        }
      })
    ).rejects.toThrow(/invalid GuiChu voice claim receipt/i);
    expect((await source.list())[0]?.clientTurnId).toBe("turn-invalid-claim-receipt");
  });

  it("refuses to send legacy pending audio without sealed GuiChu scope", async () => {
    const backing = createMemoryDirectAudioOutboxStore();
    const upload = vi.fn();
    const outbox = new DirectAudioOutbox({
      store: backing,
      transport: createGuichuVoiceTransport({
        context: () => context,
        api: { findExact: vi.fn(async () => null), upload }
      })
    });
    await backing.put({
      version: 1,
      clientTurnId: "turn-unscoped-send",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    });

    await expect(outbox.send("turn-unscoped-send")).rejects.toThrow(
      /missing its sealed GuiChu/i
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects decoding after identity changes", async () => {
    let ownerKey = context.ownerKey;
    let identityEpoch = 1;
    let conversationId = context.conversationId;
    const codec = createGuichuOutboxCodec({
      context: () => ({ ownerKey, identityEpoch, conversationId }),
      bindingTag: ({ ownerKey, identityEpoch }) => `opaque:${ownerKey}:${identityEpoch}`,
      seal: async ({ record }) => record,
      open: async ({ sealed }) => sealed
    });
    const record = {
      version: 1 as const,
      clientTurnId: "turn-synthetic-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    };
    const envelope = await codec.encode(record);
    conversationId = "conversation-synthetic-2";
    await expect(codec.decode(envelope)).resolves.toMatchObject({
      clientTurnId: "turn-synthetic-1"
    });
    ownerKey = "account-synthetic-2";
    identityEpoch += 1;
    await expect(codec.decode(envelope)).rejects.toThrow(/different GuiChu identity/i);
  });

  it("rejects an A-to-B-to-A identity transition while encoding", async () => {
    let identityEpoch = 1;
    const bindingTag = deferred<string>();
    const seal = vi.fn(async ({ record }) => record.clientTurnId);
    const codec = createGuichuOutboxCodec<string>({
      context: () => ({ ownerKey: context.ownerKey, identityEpoch }),
      bindingTag: () => bindingTag.promise,
      seal,
      open: vi.fn()
    });
    const record = {
      version: 1 as const,
      clientTurnId: "turn-synthetic-encode-race",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    };

    const encoding = codec.encode(record);
    identityEpoch = 3;
    bindingTag.resolve("opaque-synthetic-owner");

    await expect(encoding).rejects.toThrow(/identity changed/i);
    expect(seal).not.toHaveBeenCalled();
  });

  it("does not return plaintext when identity changes while opening", async () => {
    let identityEpoch = 1;
    const opened = deferred<{
      version: 1;
      clientTurnId: string;
      createdAt: string;
      audio: { blob: Blob; mimeType: string; durationMs: number; size: number };
    }>();
    const open = vi.fn(() => opened.promise);
    const codec = createGuichuOutboxCodec<string>({
      context: () => ({ ownerKey: context.ownerKey, identityEpoch }),
      bindingTag: () => "opaque-synthetic-owner",
      seal: vi.fn(),
      open
    });
    const record = {
      version: 1 as const,
      clientTurnId: "turn-synthetic-decode-race",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 5
      }
    };

    const decoding = codec.decode({
      bindingTag: "opaque-synthetic-owner",
      sealed: "sealed-synthetic-record"
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    identityEpoch = 2;
    opened.resolve(record);

    await expect(decoding).rejects.toThrow(/identity changed/i);
  });
});
