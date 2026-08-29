import { describe, expect, it, vi } from "vitest";
import {
  BrowserWebSpeechDictationProvider,
  applyDictationEdit,
  applyDictationResult,
  createEditableDictationDraft,
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
    }
  ])("rejects malformed transport payloads at runtime", (payload) => {
    expect(() => validateDirectAudioMessage(payload)).toThrowError();
  });
});
