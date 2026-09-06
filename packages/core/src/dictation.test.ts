import { describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  BrowserWebSpeechDictationProvider,
  DirectAudioOutbox,
  applyDictationEdit,
  applyDictationResult,
  createEditableDictationDraft,
  createMemoryDirectAudioOutboxStore,
  createIndexedDbDirectAudioOutboxStore,
  reconcileAuthoritativeDictation,
  runAuthoritativeDictationFallback,
  uploadDirectAudioMessage,
  validateDirectAudioMessage,
  type DirectAudioUploadTransport,
  type WebSpeechRecognitionErrorEventLike,
  type WebSpeechRecognitionEventLike,
  type WebSpeechRecognitionLike
} from "./index";

const audio = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 750,
  size: 3
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

describe("editable streaming dictation", () => {
  it("keeps interim text outside the editable value and appends final segments", () => {
    const initial = createEditableDictationDraft("Typed first.");
    const interim = applyDictationResult(initial, {
      transcript: "temporary words",
      isFinal: false
    });

    expect(interim.value).toBe("Typed first.");
    expect(interim.interimText).toBe("temporary words");

    const final = applyDictationResult(interim, {
      transcript: "final words",
      isFinal: true
    });
    expect(final.value).toBe("Typed first. final words");
    expect(final.committedText).toBe("final words");
    expect(final.interimText).toBe("");
  });

  it("never overwrites user edits with an authoritative fallback", () => {
    const streamed = applyDictationResult(createEditableDictationDraft(""), {
      transcript: "streamed version",
      isFinal: true
    });
    const edited = applyDictationEdit(streamed, "user-edited version");
    const outcome = reconcileAuthoritativeDictation(edited, "authoritative version");

    expect(outcome.resolution).toBe("review-required");
    expect(outcome.draft.value).toBe("user-edited version");
    expect(outcome.draft.authoritativeSuggestion).toBe("authoritative version");
  });

  it("automatically applies the batch result while streaming text is untouched", async () => {
    const streamed = applyDictationResult(createEditableDictationDraft("Note:"), {
      transcript: "rough words",
      isFinal: true
    });
    const transcribe = vi.fn(async () => ({ text: "clean words" }));
    const outcome = await runAuthoritativeDictationFallback({
      draft: streamed,
      audio,
      transcribe
    });

    expect(outcome.resolution).toBe("applied");
    expect(outcome.draft.value).toBe("Note: clean words");
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining(audio));
  });
});

class FakeRecognition implements WebSpeechRecognitionLike {
  static latest: FakeRecognition | null = null;

  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: WebSpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: WebSpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onend?.());
  readonly abort = vi.fn();

  constructor() {
    FakeRecognition.latest = this;
  }

  emit(transcript: string, isFinal: boolean, resultIndex = 0): void {
    const alternative = { transcript, confidence: 0.91 };
    const result = { 0: alternative, length: 1, isFinal };
    this.onresult?.({
      resultIndex,
      results: { 0: result, length: 1 }
    });
  }
}

describe("browser Web Speech provider", () => {
  it("cleans lifecycle handlers and throws VoiceInputError when start throws", async () => {
    class ThrowingRecognition extends FakeRecognition {
      override readonly start = vi.fn(() => {
        throw new DOMException("already started", "InvalidStateError");
      });
    }
    const lifecycle = new EventTarget();
    const visibility = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    visibility.visibilityState = "visible";
    const removeLifecycle = vi.spyOn(lifecycle, "removeEventListener");
    const removeVisibility = vi.spyOn(visibility, "removeEventListener");
    const provider = new BrowserWebSpeechDictationProvider({
      RecognitionConstructor: ThrowingRecognition,
      pageLifecycleTarget: lifecycle,
      visibilityDocument: visibility
    });

    await expect(provider.start({ onResult: vi.fn() })).rejects.toMatchObject({
      name: "VoiceInputError",
      code: "transcription-failed"
    });
    expect(removeLifecycle).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(removeVisibility).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    );
    expect(FakeRecognition.latest?.onresult).toBeNull();
    expect(FakeRecognition.latest?.onerror).toBeNull();
    expect(FakeRecognition.latest?.onend).toBeNull();
  });

  it("emits interim and final segments through the provider-neutral contract", async () => {
    const onResult = vi.fn();
    const provider = new BrowserWebSpeechDictationProvider({
      RecognitionConstructor: FakeRecognition,
      continuous: true
    });
    const session = await provider.start({ language: "en-US", onResult });
    const recognition = FakeRecognition.latest!;

    expect(recognition.start).toHaveBeenCalledOnce();
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.lang).toBe("en-US");

    recognition.emit("temporary", false);
    recognition.emit("finished", true);
    expect(onResult).toHaveBeenNthCalledWith(1, {
      transcript: "temporary",
      isFinal: false
    });
    expect(onResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ transcript: "finished", isFinal: true })
    );
    expect(onResult).toHaveBeenLastCalledWith({ transcript: "", isFinal: false });

    await session.stop();
    await expect(session.result).resolves.toBeUndefined();
  });

  it("settles cancellation even if the browser never emits end", async () => {
    const provider = new BrowserWebSpeechDictationProvider({
      RecognitionConstructor: FakeRecognition
    });
    const session = await provider.start({ onResult: vi.fn() });
    const result = session.result.catch((error: unknown) => {
      throw error;
    });
    session.cancel();

    await expect(result).rejects.toMatchObject({ code: "capture-cancelled" });
    expect(FakeRecognition.latest!.abort).toHaveBeenCalledOnce();
  });

  it("restarts after a natural end and accepts final index zero again", async () => {
    vi.useFakeTimers();
    try {
      const onResult = vi.fn();
      const provider = new BrowserWebSpeechDictationProvider({
        RecognitionConstructor: FakeRecognition,
        restartDelayMs: 25
      });
      const session = await provider.start({ onResult });
      const recognition = FakeRecognition.latest!;
      recognition.emit("first segment", true);
      recognition.onend?.();
      await vi.advanceTimersByTimeAsync(25);
      expect(recognition.start).toHaveBeenCalledTimes(2);

      recognition.emit("second segment", true);
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: "first segment", isFinal: true })
      );
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: "second segment", isFinal: true })
      );
      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats no-speech as a natural end and restarts", async () => {
    vi.useFakeTimers();
    try {
      const provider = new BrowserWebSpeechDictationProvider({
        RecognitionConstructor: FakeRecognition,
        restartDelayMs: 10
      });
      const session = await provider.start({ onResult: vi.fn() });
      const recognition = FakeRecognition.latest!;
      recognition.onerror?.({ error: "no-speech" });
      recognition.onend?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(recognition.start).toHaveBeenCalledTimes(2);
      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops cleanly during the natural-end restart window", async () => {
    vi.useFakeTimers();
    try {
      const provider = new BrowserWebSpeechDictationProvider({
        RecognitionConstructor: FakeRecognition,
        restartDelayMs: 50
      });
      const session = await provider.start({ onResult: vi.fn() });
      const recognition = FakeRecognition.latest!;
      recognition.onend?.();
      recognition.onend?.();
      await expect(session.stop()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(50);
      expect(recognition.start).toHaveBeenCalledOnce();
      expect(recognition.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats no-speech emitted by an explicit stop as successful completion", async () => {
    class NoSpeechOnStopRecognition extends FakeRecognition {
      override readonly stop = vi.fn(() => {
        this.onerror?.({ error: "no-speech" });
        this.onend?.();
      });
    }
    const provider = new BrowserWebSpeechDictationProvider({
      RecognitionConstructor: NoSpeechOnStopRecognition
    });
    const session = await provider.start({ onResult: vi.fn() });

    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.result).resolves.toBeUndefined();
  });

  it("aborts immediately on pagehide and fences a queued restart", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new EventTarget();
      const provider = new BrowserWebSpeechDictationProvider({
        RecognitionConstructor: FakeRecognition,
        restartDelayMs: 25,
        pageLifecycleTarget: lifecycle
      });
      const session = await provider.start({ onResult: vi.fn() });
      const recognition = FakeRecognition.latest!;
      recognition.onend?.();
      lifecycle.dispatchEvent(new Event("pagehide"));

      await expect(session.result).rejects.toMatchObject({ code: "capture-cancelled" });
      expect(recognition.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      expect(recognition.start).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when hidden and never revives recognition from a restart timer", async () => {
    vi.useFakeTimers();
    try {
      const visibility = new EventTarget() as EventTarget & {
        visibilityState: DocumentVisibilityState;
      };
      visibility.visibilityState = "visible";
      const provider = new BrowserWebSpeechDictationProvider({
        RecognitionConstructor: FakeRecognition,
        restartDelayMs: 25,
        visibilityDocument: visibility
      });
      const session = await provider.start({ onResult: vi.fn() });
      const recognition = FakeRecognition.latest!;
      recognition.onend?.();
      visibility.visibilityState = "hidden";
      visibility.dispatchEvent(new Event("visibilitychange"));

      await expect(session.result).rejects.toMatchObject({ code: "capture-cancelled" });
      expect(recognition.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      expect(recognition.start).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("direct audio transport", () => {
  it("returns validated playable message metadata", async () => {
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async ({ clientMessageId }) => ({
        id: "server-message-1",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/message-1.webm",
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
          size: audio.size
        }
      }))
    };

    const message = await uploadDirectAudioMessage(transport, {
      clientMessageId: "client-message-1",
      audio
    });
    expect(message.audio.url).toContain("message-1.webm");
  });

  it("rejects mismatched client ids to prevent late uploads attaching to another message", async () => {
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async () => ({
        id: "server-message-2",
        clientMessageId: "different-client-message",
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/message-2.webm",
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
          size: audio.size
        }
      }))
    };

    await expect(
      uploadDirectAudioMessage(transport, {
        clientMessageId: "client-message-2",
        audio
      })
    ).rejects.toMatchObject({ code: "submission-failed" });
  });

  it.each([
    null,
    {},
    {
      id: "message",
      clientMessageId: "client",
      kind: "text",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {}
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "not-a-date",
      audio: { url: "/audio", mimeType: "audio/webm", durationMs: 1, size: 1 }
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "text/plain", durationMs: 1, size: 1 }
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "audio/webm", durationMs: NaN, size: 1 }
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "audio/webm", durationMs: 1, size: 1.5 }
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "audio/webm", durationMs: 1, size: 1 },
      transcript: 42
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "audio/webm", durationMs: 1, size: 1 },
      metadata: { retention: 30 }
    },
    {
      id: "message",
      clientMessageId: "client",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: { url: "/audio", mimeType: "audio/webm", durationSeconds: 1e308, size: 1 }
    }
  ])("rejects malformed transport payloads at runtime", (payload) => {
    expect(() => validateDirectAudioMessage(payload)).toThrowError();
  });

  it("normalizes legacy durationSeconds to durationMs", () => {
    const message = validateDirectAudioMessage({
      id: "server-message-legacy",
      clientMessageId: "client-message-legacy",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        url: "/audio/legacy",
        mimeType: "audio/webm",
        durationSeconds: 1.25,
        size: 3
      }
    });
    expect(message.audio.durationMs).toBe(1_250);
  });
});

describe("durable direct-audio outbox", () => {
  it("orders in-memory pending turns by creation time", async () => {
    const store = createMemoryDirectAudioOutboxStore();
    await store.put({
      version: 1,
      clientTurnId: "turn-later",
      createdAt: "2026-01-02T00:00:00.000Z",
      audio
    });
    await store.put({
      version: 1,
      clientTurnId: "turn-earlier",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio
    });
    expect((await store.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-earlier",
      "turn-later"
    ]);
  });

  it("keeps a stable turn after response loss and reconciles exact server state", async () => {
    const store = createMemoryDirectAudioOutboxStore();
    let remote: Awaited<ReturnType<DirectAudioUploadTransport["upload"]>> | null = null;
    const upload = vi.fn(async ({ clientMessageId }) => {
      remote = {
        id: "server-outbox-1",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "/audio/server-outbox-1",
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
          size: audio.size
        }
      };
      throw new Error("synthetic response loss");
    });
    const find = vi.fn(async () => remote);
    const outbox = new DirectAudioOutbox({ store, transport: { upload, find } });
    const record = await outbox.stage({ audio, clientTurnId: "turn-outbox-1" });

    await expect(outbox.send(record)).rejects.toThrow(/response loss/);
    expect(await store.get(record.clientTurnId)).not.toBeNull();
    const recovered = await outbox.send(record.clientTurnId);

    expect(recovered.recoveredFromServer).toBe(true);
    expect(recovered.message.clientMessageId).toBe("turn-outbox-1");
    expect(upload).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledTimes(2);
    expect(await store.get(record.clientTurnId)).toBeNull();
  });

  it("coalesces same-turn sends into one exact lookup and one upload", async () => {
    const store = createMemoryDirectAudioOutboxStore();
    const transport = {
      find: vi.fn(async () => null),
      upload: vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({
        id: "server-outbox-2",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "/audio/server-outbox-2",
          mimeType: audio.mimeType,
          durationMs: audio.durationMs,
          size: audio.size
        }
      }))
    };
    const outbox = new DirectAudioOutbox({ store, transport });
    const record = await outbox.stage({ audio, clientTurnId: "turn-outbox-2" });
    const [first, second] = await Promise.all([outbox.send(record), outbox.send(record)]);
    expect(first.message.id).toBe(second.message.id);
    expect(transport.find).toHaveBeenCalledOnce();
    expect(transport.upload).toHaveBeenCalledOnce();
  });

  it("never replaces already-staged audio for the same stable turn", async () => {
    const store = createMemoryDirectAudioOutboxStore();
    const outbox = new DirectAudioOutbox({
      store,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    const first = await outbox.stage({ audio, clientTurnId: "turn-stable-audio-1" });
    const second = await outbox.stage({
      clientTurnId: "turn-stable-audio-1",
      audio: {
        blob: new Blob([new Uint8Array([9, 9])], { type: "audio/webm" }),
        mimeType: "audio/webm",
        durationMs: 500,
        size: 2
      }
    });
    expect(second.audio.size).toBe(first.audio.size);
    expect((await store.get(first.clientTurnId))?.audio.size).toBe(audio.size);
  });

  it("requires a codec boundary for durable IndexedDB round trips", async () => {
    const sealed = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const store = createIndexedDbDirectAudioOutboxStore({
      indexedDB: new IDBFactory(),
      keyRange: IDBKeyRange,
      databaseName: "synthetic-outbox-test",
      partition: "opaque-owner-synthetic-1",
      codec: {
        async encode(record) {
          const token = `sealed:${record.clientTurnId}`;
          sealed.set(token, record);
          return token;
        },
        async decode(token) {
          const record = sealed.get(token);
          if (!record) throw new Error("missing synthetic sealed payload");
          return record;
        }
      }
    });
    const outbox = new DirectAudioOutbox({
      store,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    const record = await outbox.stage({ audio, clientTurnId: "turn-indexeddb-1" });
    expect((await store.get(record.clientTurnId))?.audio.size).toBe(audio.size);
    expect((await store.list()).map((item) => item.clientTurnId)).toEqual([
      "turn-indexeddb-1"
    ]);
    await store.delete(record.clientTurnId);
    expect(await store.get(record.clientTurnId)).toBeNull();
    await outbox.stage({ audio, clientTurnId: "turn-indexeddb-2" });
    await store.clear();
    expect(await store.get("turn-indexeddb-2")).toBeNull();
  });

  it("partitions IndexedDB recovery and clearing by opaque owner scope", async () => {
    const indexedDB = new IDBFactory();
    const sealed = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const codec = (prefix: string) => ({
      async encode(record: (typeof sealed extends Map<string, infer R> ? R : never)) {
        const token = `${prefix}:${record.clientTurnId}`;
        sealed.set(token, record);
        return token;
      },
      async decode(token: string) {
        if (!token.startsWith(`${prefix}:`)) {
          throw new Error("foreign synthetic partition was decoded");
        }
        const record = sealed.get(token);
        if (!record) throw new Error("missing synthetic sealed payload");
        return record;
      }
    });
    const firstStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName: "synthetic-partitioned-outbox-test",
      partition: "opaque-owner-a",
      codec: codec("a")
    });
    const secondStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName: "synthetic-partitioned-outbox-test",
      partition: "opaque-owner-b",
      codec: codec("b")
    });
    const transport = { find: vi.fn(async () => null), upload: vi.fn() };
    const first = new DirectAudioOutbox({ store: firstStore, transport });
    const second = new DirectAudioOutbox({ store: secondStore, transport });

    await first.stage({ audio, clientTurnId: "turn-shared-id", metadata: { marker: "a" } });
    await second.stage({ audio, clientTurnId: "turn-shared-id", metadata: { marker: "b" } });
    expect((await firstStore.list()).map((record) => record.metadata?.marker)).toEqual(["a"]);
    expect((await secondStore.list()).map((record) => record.metadata?.marker)).toEqual(["b"]);

    await first.clear();
    expect(await firstStore.list()).toEqual([]);
    expect((await secondStore.list()).map((record) => record.metadata?.marker)).toEqual(["b"]);
  });

  it("drops unpartitioned v1 IndexedDB rows during the v2 schema upgrade", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-outbox-v1-upgrade-test";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("pending-audio", { keyPath: "clientTurnId" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("pending-audio", "readwrite");
        transaction.objectStore("pending-audio").add({
          clientTurnId: "legacy-unpartitioned-turn",
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: "legacy-unpartitioned-payload"
        });
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
      };
    });
    const sealed = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const store = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-upgraded-owner",
      codec: {
        async encode(record) {
          const token = `sealed-upgrade:${record.clientTurnId}`;
          sealed.set(token, record);
          return token;
        },
        async decode(token: string) {
          const record = sealed.get(token);
          if (!record) throw new Error("legacy row must not survive the upgrade");
          return record;
        }
      }
    });
    const outbox = new DirectAudioOutbox({
      store,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });

    expect(await store.list()).toEqual([]);
    await outbox.stage({ audio, clientTurnId: "turn-after-partition-upgrade" });
    expect((await store.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-after-partition-upgrade"
    ]);
  });

  it("prevents a delayed tab write from reviving rows after another tab clears", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-cross-tab-clear-cas";
    const encodeStarted = deferred<void>();
    const releaseEncode = deferred<void>();
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const delayedCodec = {
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        encodeStarted.resolve();
        await releaseEncode.promise;
        records.set(record.clientTurnId, record);
        return record.clientTurnId;
      },
      async decode(token: string) {
        const record = records.get(token);
        if (!record) throw new Error("missing synthetic record");
        return record;
      }
    };
    const fastCodec = {
      async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
        records.set(record.clientTurnId, record);
        return record.clientTurnId;
      },
      decode: delayedCodec.decode
    };
    const firstStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-owner-cross-tab",
      codec: delayedCodec
    });
    const secondStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-owner-cross-tab",
      codec: fastCodec
    });
    const first = new DirectAudioOutbox({
      store: firstStore,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });

    const staging = first.stage({ audio, clientTurnId: "turn-delayed-cross-tab" });
    await encodeStarted.promise;
    await secondStore.clear();
    releaseEncode.resolve();

    await expect(staging).rejects.toMatchObject({ code: "submission-failed" });
    expect(await firstStore.list()).toEqual([]);
    expect(await firstStore.getPartitionEpoch()).toBe(1);
  });

  it("atomically rejects a durable claim when another tab clears its source", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-cross-tab-claim-cas";
    const sourceRecords = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const targetRecords = new Map(sourceRecords);
    const targetEncodeStarted = deferred<void>();
    const releaseTargetEncode = deferred<void>();
    const sourceCodec = {
      async encode(record: (typeof sourceRecords extends Map<string, infer R> ? R : never)) {
        sourceRecords.set(record.clientTurnId, record);
        return record.clientTurnId;
      },
      async decode(token: string) {
        const record = sourceRecords.get(token);
        if (!record) throw new Error("missing source record");
        return record;
      }
    };
    const targetCodec = {
      async encode(record: (typeof sourceRecords extends Map<string, infer R> ? R : never)) {
        targetEncodeStarted.resolve();
        await releaseTargetEncode.promise;
        targetRecords.set(record.clientTurnId, record);
        return record.clientTurnId;
      },
      async decode(token: string) {
        const record = targetRecords.get(token);
        if (!record) throw new Error("missing target record");
        return record;
      }
    };
    const sourceStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-guest-claim",
      codec: sourceCodec
    });
    const clearingStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-guest-claim",
      codec: sourceCodec
    });
    const targetStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-account-claim",
      codec: targetCodec
    });
    const outbox = new DirectAudioOutbox({
      store: sourceStore,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await outbox.stage({ audio, clientTurnId: "turn-claim-race" });

    const claiming = sourceStore.claimTo({
      clientTurnId: "turn-claim-race",
      targetPartition: "opaque-account-claim",
      targetCodec,
      transform: (record) => ({ ...record, metadata: { claimed: "true" } })
    });
    await targetEncodeStarted.promise;
    await clearingStore.clear();
    releaseTargetEncode.resolve();

    await expect(claiming).rejects.toMatchObject({ code: "submission-failed" });
    expect(await sourceStore.list()).toEqual([]);
    expect(await targetStore.list()).toEqual([]);
  });

  it("supports two custom store names in one IndexedDB database", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-multi-store-registry";
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
        if (!record) throw new Error("missing custom-store payload");
        return record;
      }
    });
    const firstStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      storeName: "voice-a",
      partition: "opaque-owner-custom",
      codec: codec("a")
    });
    const first = new DirectAudioOutbox({
      store: firstStore,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await first.stage({ audio, clientTurnId: "turn-custom-a" });
    const secondStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      storeName: "voice-b",
      partition: "opaque-owner-custom",
      codec: codec("b")
    });
    const second = new DirectAudioOutbox({
      store: secondStore,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });
    await second.stage({ audio, clientTurnId: "turn-custom-b" });

    expect((await firstStore.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-custom-a"
    ]);
    expect((await secondStore.list()).map((record) => record.clientTurnId)).toEqual([
      "turn-custom-b"
    ]);
  });

  it("rejects custom names reserved for IndexedDB control stores", () => {
    expect(() =>
      createIndexedDbDirectAudioOutboxStore({
        indexedDB: new IDBFactory(),
        keyRange: IDBKeyRange,
        databaseName: "synthetic-reserved-store-name",
        storeName: "editable-voice-input-outbox-partitions:voice-a",
        partition: "opaque-reserved-owner",
        codec: { encode: vi.fn(), decode: vi.fn() }
      })
    ).toThrow(/non-reserved logical store name/i);
  });

  it("fails closed without deleting a host store when a custom keyPath collides", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-custom-store-keypath-collision";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("host-owned-records", { keyPath: "hostId" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("host-owned-records", "readwrite");
        transaction.objectStore("host-owned-records").add({
          hostId: "host-row-synthetic-1",
          protected: true
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const store = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      storeName: "host-owned-records",
      partition: "opaque-collision-owner",
      codec: { encode: vi.fn(), decode: vi.fn() }
    });

    await expect(store.list()).rejects.toThrow(/incompatible keyPath/i);

    const preserved = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("host-owned-records", "readonly");
        const get = transaction.objectStore("host-owned-records").get("host-row-synthetic-1");
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
        transaction.oncomplete = () => database.close();
      };
    });
    expect(preserved).toEqual({ hostId: "host-row-synthetic-1", protected: true });
  });

  it("serializes concurrent custom-store schema registration", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-concurrent-store-registry";
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const create = (storeName: string) => {
      const codec = {
        async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
          const token = `${storeName}:${record.clientTurnId}`;
          records.set(token, record);
          return token;
        },
        async decode(token: string) {
          const record = records.get(token);
          if (!record) throw new Error("missing concurrent-store payload");
          return record;
        }
      };
      const store = createIndexedDbDirectAudioOutboxStore({
        indexedDB,
        keyRange: IDBKeyRange,
        databaseName,
        storeName,
        partition: "opaque-concurrent-owner",
        codec
      });
      return {
        store,
        outbox: new DirectAudioOutbox({
          store,
          transport: { find: vi.fn(async () => null), upload: vi.fn() }
        })
      };
    };
    const first = create("voice-concurrent-a");
    const second = create("voice-concurrent-b");

    await Promise.all([
      first.outbox.stage({ audio, clientTurnId: "turn-concurrent-a" }),
      second.outbox.stage({ audio, clientTurnId: "turn-concurrent-b" })
    ]);
    expect((await first.store.list())[0]?.clientTurnId).toBe("turn-concurrent-a");
    expect((await second.store.list())[0]?.clientTurnId).toBe("turn-concurrent-b");
  });

  it("opens and exercises five custom stores concurrently without version races", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-five-store-concurrency-stress";
    const records = new Map<string, Parameters<DirectAudioOutbox["stage"]>[0] & {
      clientTurnId: string;
      createdAt: string;
      version: 1;
    }>();
    const instances = Array.from({ length: 5 }, (_, index) => {
      const storeName = `voice-stress-${index}`;
      const codec = {
        async encode(record: (typeof records extends Map<string, infer R> ? R : never)) {
          const token = `${storeName}:${record.clientTurnId}`;
          records.set(token, record);
          await Promise.resolve();
          return token;
        },
        async decode(token: string) {
          await Promise.resolve();
          const record = records.get(token);
          if (!record) throw new Error("missing five-store stress payload");
          return record;
        }
      };
      const store = createIndexedDbDirectAudioOutboxStore({
        indexedDB,
        keyRange: IDBKeyRange,
        databaseName,
        storeName,
        partition: "opaque-five-store-owner",
        codec
      });
      return {
        index,
        store,
        outbox: new DirectAudioOutbox({
          store,
          transport: { find: vi.fn(async () => null), upload: vi.fn() }
        })
      };
    });

    await Promise.all(
      instances.map(({ index, outbox }) =>
        outbox.stage({ audio, clientTurnId: `turn-five-store-${index}` })
      )
    );
    await expect(
      Promise.all(
        instances.map(async ({ index, store }) => ({
          epoch: await store.getPartitionEpoch(),
          ids: (await store.list()).map((record) => record.clientTurnId),
          exact: (await store.get(`turn-five-store-${index}`))?.clientTurnId
        }))
      )
    ).resolves.toEqual(
      instances.map(({ index }) => ({
        epoch: 0,
        ids: [`turn-five-store-${index}`],
        exact: `turn-five-store-${index}`
      }))
    );
    await Promise.all(instances.map(({ store }) => store.clear()));
    await expect(Promise.all(instances.map(({ store }) => store.list()))).resolves.toEqual([
      [],
      [],
      [],
      [],
      []
    ]);
  });

  it("invalidates an old sender after another tab clears the durable partition", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-send-lease-clear";
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
        if (!record) throw new Error("missing lease payload");
        return record;
      }
    };
    const senderStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-send-owner",
      codec
    });
    const clearingStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-send-owner",
      codec
    });
    const lookup = deferred<null>();
    const upload = vi.fn();
    const find = vi.fn(() => lookup.promise);
    const outbox = new DirectAudioOutbox({
      store: senderStore,
      transport: { find, upload }
    });
    await outbox.stage({ audio, clientTurnId: "turn-send-lease-clear" });
    const sending = outbox.send("turn-send-lease-clear");
    await vi.waitFor(() => expect(find).toHaveBeenCalledOnce());
    await clearingStore.clear();
    lookup.resolve(null);

    await expect(sending).rejects.toMatchObject({ code: "submission-failed" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("serializes cross-tab sends with a durable lease and releases it after failure", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-cross-tab-send-lease";
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
        if (!record) throw new Error("missing serialized-send payload");
        return record;
      }
    };
    const firstStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-serialized-owner",
      codec
    });
    const secondStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-serialized-owner",
      codec
    });
    const firstLookup = deferred<null>();
    const firstFind = vi.fn(() => firstLookup.promise);
    const first = new DirectAudioOutbox({
      store: firstStore,
      transport: { find: firstFind, upload: vi.fn() }
    });
    const second = new DirectAudioOutbox({
      store: secondStore,
      transport: {
        find: vi.fn(async () => null),
        upload: vi.fn(async ({ clientMessageId }) => ({
          id: "server-serialized-send",
          clientMessageId,
          kind: "audio" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          audio: {
            url: "/audio/server-serialized-send",
            mimeType: audio.mimeType,
            durationMs: audio.durationMs,
            size: audio.size
          }
        }))
      }
    });
    await first.stage({ audio, clientTurnId: "turn-serialized-send" });
    const firstSending = first.send("turn-serialized-send");
    await vi.waitFor(() => expect(firstFind).toHaveBeenCalledOnce());

    await expect(second.send("turn-serialized-send")).rejects.toThrow(
      /another browser instance/i
    );
    firstLookup.reject(new Error("synthetic lookup failure"));
    await expect(firstSending).rejects.toThrow(/synthetic lookup failure/i);
    await expect(second.send("turn-serialized-send")).resolves.toMatchObject({
      message: { id: "server-serialized-send" }
    });
    expect(await secondStore.get("turn-serialized-send")).toBeNull();
  });

  it("invalidates an old sender after a durable guest-to-account claim", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-send-lease-claim";
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
        if (!record) throw new Error("missing claim lease payload");
        return record;
      }
    });
    const sourceStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-guest-send",
      codec: codec("guest")
    });
    const targetStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-account-send",
      codec: codec("account")
    });
    const lookup = deferred<null>();
    const find = vi.fn(() => lookup.promise);
    const upload = vi.fn();
    const outbox = new DirectAudioOutbox({
      store: sourceStore,
      transport: { find, upload }
    });
    await outbox.stage({ audio, clientTurnId: "turn-send-lease-claim" });
    const sending = outbox.send("turn-send-lease-claim");
    await vi.waitFor(() => expect(find).toHaveBeenCalledOnce());
    await sourceStore.claimTo({
      clientTurnId: "turn-send-lease-claim",
      targetPartition: "opaque-account-send",
      targetCodec: codec("account"),
      transform: (record) => ({ ...record, metadata: { claimed: "true" } })
    });
    lookup.resolve(null);

    await expect(sending).rejects.toMatchObject({ code: "submission-failed" });
    expect(upload).not.toHaveBeenCalled();
    expect(await sourceStore.list()).toEqual([]);
    expect((await targetStore.list())[0]?.metadata?.claimed).toBe("true");
  });

  it("returns server success when conditional cleanup loses its revision lease", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "synthetic-send-receipt-cleanup-race";
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
        if (!record) throw new Error("missing receipt payload");
        return record;
      }
    };
    const senderStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-receipt-owner",
      codec
    });
    const clearingStore = createIndexedDbDirectAudioOutboxStore({
      indexedDB,
      keyRange: IDBKeyRange,
      databaseName,
      partition: "opaque-receipt-owner",
      codec
    });
    const outbox = new DirectAudioOutbox({
      store: senderStore,
      transport: {
        find: vi.fn(async () => null),
        upload: vi.fn(async ({ clientMessageId }) => {
          await clearingStore.clear();
          return {
            id: "server-receipt-race",
            clientMessageId,
            kind: "audio" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            audio: {
              url: "/audio/server-receipt-race",
              mimeType: audio.mimeType,
              durationMs: audio.durationMs,
              size: audio.size
            }
          };
        })
      }
    });
    await outbox.stage({ audio, clientTurnId: "turn-server-receipt-race" });

    await expect(outbox.send("turn-server-receipt-race")).resolves.toMatchObject({
      message: { id: "server-receipt-race" },
      recoveredFromServer: false,
      cleanupPending: true
    });
  });

  it("keeps a pending receipt but reports success when local delete aborts", async () => {
    const backing = createMemoryDirectAudioOutboxStore();
    const lease = {
      clientTurnId: "turn-delete-abort",
      revision: "revision-delete-abort",
      partitionEpoch: 0,
      token: "lease-delete-abort",
      record: null as never
    };
    let leaseHeld = false;
    let deleteAttempts = 0;
    const releaseSendLease = vi.fn(async () => {
      leaseHeld = false;
    });
    const store = {
      ...backing,
      async acquireSendLease(clientTurnId: string) {
        if (leaseHeld) throw new Error("synthetic active lease");
        const record = await backing.get(clientTurnId);
        if (!record) throw new Error("missing pending receipt");
        leaseHeld = true;
        return { ...lease, clientTurnId, record };
      },
      async assertSendLease() {},
      async deleteIfSendLease(currentLease: typeof lease) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new DOMException("transaction aborted", "AbortError");
        }
        await backing.delete(currentLease.clientTurnId);
        leaseHeld = false;
        return true;
      },
      releaseSendLease
    };
    const serverMessage = {
      id: "server-delete-abort",
      clientMessageId: "turn-delete-abort",
      kind: "audio" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        url: "/audio/server-delete-abort",
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
        size: audio.size
      }
    };
    const outbox = new DirectAudioOutbox({
      store,
      transport: {
        find: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(serverMessage),
        upload: vi.fn(async () => serverMessage)
      }
    });
    await outbox.stage({ audio, clientTurnId: "turn-delete-abort" });

    await expect(outbox.send("turn-delete-abort")).resolves.toMatchObject({
      message: { id: "server-delete-abort" },
      cleanupPending: true
    });
    expect(releaseSendLease).toHaveBeenCalledOnce();
    expect(await backing.get("turn-delete-abort")).not.toBeNull();

    await expect(outbox.send("turn-delete-abort")).resolves.toMatchObject({
      message: { id: "server-delete-abort" },
      recoveredFromServer: true
    });
    expect(await backing.get("turn-delete-abort")).toBeNull();
  });

  it("fences a pending stage before clear can finish", async () => {
    const backing = createMemoryDirectAudioOutboxStore();
    const putStarted = deferred<void>();
    const releasePut = deferred<void>();
    const store = {
      ...backing,
      async put(record: Parameters<typeof backing.put>[0]) {
        putStarted.resolve();
        await releasePut.promise;
        await backing.put(record);
      }
    };
    const outbox = new DirectAudioOutbox({
      store,
      transport: { find: vi.fn(async () => null), upload: vi.fn() }
    });

    const staging = outbox.stage({ audio, clientTurnId: "turn-clear-stage" });
    await putStarted.promise;
    const clearing = outbox.clear();
    releasePut.resolve();

    await expect(staging).rejects.toMatchObject({ code: "submission-failed" });
    await clearing;
    expect(await store.list()).toEqual([]);
  });

  it("aborts and fences lookup-to-upload when clear changes the outbox generation", async () => {
    const store = createMemoryDirectAudioOutboxStore();
    const lookup = deferred<null>();
    let lookupSignal: AbortSignal | undefined;
    const upload = vi.fn();
    const outbox = new DirectAudioOutbox({
      store,
      transport: {
        find: vi.fn(({ signal }) => {
          lookupSignal = signal;
          return lookup.promise;
        }),
        upload
      }
    });
    const record = await outbox.stage({ audio, clientTurnId: "turn-clear-send" });
    const sending = outbox.send(record);
    await vi.waitFor(() => expect(lookupSignal).toBeDefined());

    const clearing = outbox.clear();
    expect(lookupSignal?.aborted).toBe(true);
    lookup.resolve(null);

    await expect(sending).rejects.toMatchObject({ code: "submission-failed" });
    await clearing;
    expect(upload).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("relies on an atomic server idempotency key across two tab outboxes", async () => {
    const remote = new Map<string, Awaited<ReturnType<DirectAudioUploadTransport["upload"]>>>();
    let lookups = 0;
    let releaseLookups!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    let created = 0;
    const transport = {
      async find({ clientMessageId }: { clientMessageId: string }) {
        const existing = remote.get(clientMessageId) ?? null;
        lookups += 1;
        if (lookups === 2) releaseLookups();
        await bothLookedUp;
        return existing;
      },
      async upload({ clientMessageId }: { clientMessageId: string }) {
        const existing = remote.get(clientMessageId);
        if (existing) return existing;
        created += 1;
        const message = {
          id: "server-atomic-1",
          clientMessageId,
          kind: "audio" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          audio: {
            url: "/audio/server-atomic-1",
            mimeType: audio.mimeType,
            durationMs: audio.durationMs,
            size: audio.size
          }
        };
        remote.set(clientMessageId, message);
        return message;
      }
    };
    const first = new DirectAudioOutbox({
      store: createMemoryDirectAudioOutboxStore(),
      transport
    });
    const second = new DirectAudioOutbox({
      store: createMemoryDirectAudioOutboxStore(),
      transport
    });
    const [firstRecord, secondRecord] = await Promise.all([
      first.stage({ audio, clientTurnId: "turn-cross-tab-1" }),
      second.stage({ audio, clientTurnId: "turn-cross-tab-1" })
    ]);
    const [firstResult, secondResult] = await Promise.all([
      first.send(firstRecord),
      second.send(secondRecord)
    ]);
    expect(created).toBe(1);
    expect(firstResult.message.id).toBe(secondResult.message.id);
  });
});
