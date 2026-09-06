// @vitest-environment jsdom

import {
  VoiceInputError,
  type CapturedAudio,
  type DictationProvider,
  type DictationProviderStartInput,
  type DictationProviderSession,
  type DirectAudioUploadTransport,
  type VoiceCaptureSession
} from "@editable-voice-input/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DualModeVoiceInput,
  useDirectAudioMessage,
  useDualModeVoiceInput,
  useEditableDictation,
  type VoiceCaptureController
} from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const audio: CapturedAudio = {
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
  mimeType: "audio/webm",
  durationMs: 900,
  size: 3
};

function makeCapture() {
  const completion = deferred<CapturedAudio>();
  const session: VoiceCaptureSession = {
    active: true,
    result: completion.promise,
    stop: vi.fn(async () => {
      completion.resolve(audio);
      return completion.promise;
    }),
    cancel: vi.fn()
  };
  const capture: VoiceCaptureController = {
    start: vi.fn(async () => session),
    cancel: vi.fn(),
    dispose: vi.fn()
  };
  return { capture, session };
}

function makePendingCapture() {
  const firstStart = deferred<VoiceCaptureSession>();
  const secondStart = deferred<VoiceCaptureSession>();
  const capture: VoiceCaptureController = {
    start: vi
      .fn<VoiceCaptureController["start"]>()
      .mockImplementationOnce(() => firstStart.promise)
      .mockImplementationOnce(() => secondStart.promise),
    cancel: vi.fn(),
    dispose: vi.fn()
  };
  return { capture, firstStart, secondStart };
}

function inertCaptureSession(): VoiceCaptureSession {
  return {
    active: true,
    result: new Promise<CapturedAudio>(() => undefined),
    stop: vi.fn(() => new Promise<CapturedAudio>(() => undefined)),
    cancel: vi.fn()
  };
}

function makeDictationProvider() {
  const completion = deferred<void>();
  let input: DictationProviderStartInput | null = null;
  const session: DictationProviderSession = {
    active: true,
    result: completion.promise,
    stop: vi.fn(async () => {
      completion.resolve();
      return completion.promise;
    }),
    cancel: vi.fn()
  };
  const provider: DictationProvider = {
    start: vi.fn(async (nextInput) => {
      input = nextInput;
      return session;
    })
  };
  return {
    provider,
    session,
    emit(result: { transcript: string; isFinal: boolean }) {
      if (!input) throw new Error("Dictation has not started");
      input.onResult(result);
    }
  };
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:anonymous-audio")
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "SpeechRecognition");
});

describe("useEditableDictation", () => {
  it("cancels pending microphone permission and can retry immediately", async () => {
    const pending = makePendingCapture();
    const dictation = makeDictationProvider();
    const firstSession = inertCaptureSession();
    const secondSession = inertCaptureSession();

    function Harness() {
      const voice = useEditableDictation({
        provider: dictation.provider,
        capture: pending.capture,
        authoritativeTranscribe: vi.fn()
      });
      return (
        <div>
          <output aria-label="pending-dictation-state">{voice.state}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            pending-dictation-start
          </button>
          <button type="button" onClick={voice.cancel}>
            pending-dictation-cancel
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "pending-dictation-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("pending-dictation-state").textContent).toBe("starting")
    );
    fireEvent.click(screen.getByRole("button", { name: "pending-dictation-cancel" }));
    expect(pending.capture.cancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "pending-dictation-start" }));
    expect(pending.capture.start).toHaveBeenCalledTimes(2);
    pending.secondStart.resolve(secondSession);
    await waitFor(() =>
      expect(screen.getByLabelText("pending-dictation-state").textContent).toBe("listening")
    );

    pending.firstStart.resolve(firstSession);
    await waitFor(() => expect(firstSession.cancel).toHaveBeenCalledOnce());
  });

  it("shows interim separately and protects edits from the authoritative fallback", async () => {
    const dictation = makeDictationProvider();
    const { capture } = makeCapture();
    const transcribe = vi.fn(async () => ({ text: "authoritative wording" }));

    function Harness() {
      const voice = useEditableDictation({
        defaultValue: "typed first",
        provider: dictation.provider,
        capture,
        authoritativeTranscribe: transcribe
      });
      return (
        <div>
          <textarea
            aria-label="draft"
            value={voice.value}
            onChange={(event) => voice.setValue(event.currentTarget.value)}
          />
          <output aria-label="interim">{voice.interimText}</output>
          <output aria-label="suggestion">{voice.authoritativeSuggestion}</output>
          <output aria-label="state">{voice.state}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            start
          </button>
          <button type="button" onClick={voice.stopDictation}>
            stop
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("listening"));

    dictation.emit({ transcript: "temporary phrase", isFinal: false });
    await waitFor(() =>
      expect(screen.getByLabelText("interim").textContent).toBe("temporary phrase")
    );
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("typed first");

    dictation.emit({ transcript: "rough phrase", isFinal: true });
    await waitFor(() =>
      expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe(
        "typed first rough phrase"
      )
    );
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "my protected edit" }
    });
    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("review"));
    expect((screen.getByLabelText("draft") as HTMLTextAreaElement).value).toBe(
      "my protected edit"
    );
    expect(screen.getByLabelText("suggestion").textContent).toBe("authoritative wording");
  });

  it("keeps recording in batch-only mode when live recognition cannot start", async () => {
    const { capture } = makeCapture();
    const provider: DictationProvider = {
      start: vi.fn(async () => {
        throw new Error("synthetic live recognition unavailable");
      })
    };
    const transcribe = vi.fn(async () => ({ text: "batch transcript" }));

    function Harness() {
      const voice = useEditableDictation({
        provider,
        capture,
        authoritativeTranscribe: transcribe
      });
      return (
        <div>
          <output aria-label="fallback-state">{voice.state}</output>
          <output aria-label="fallback-mode">{voice.recognitionMode}</output>
          <output aria-label="fallback-live-error">{voice.liveError?.code}</output>
          <output aria-label="fallback-value">{voice.value}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            fallback-start
          </button>
          <button type="button" onClick={voice.stopDictation}>
            fallback-stop
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "fallback-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("fallback-state").textContent).toBe("listening")
    );
    expect(screen.getByLabelText("fallback-mode").textContent).toBe("batch-only");
    expect(screen.getByLabelText("fallback-live-error").textContent).toBe(
      "transcription-failed"
    );

    fireEvent.click(screen.getByRole("button", { name: "fallback-stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("fallback-state").textContent).toBe("review")
    );
    expect(screen.getByLabelText("fallback-value").textContent).toBe("batch transcript");
  });

  it("does not start browser Web Speech unless the host explicitly opts in", async () => {
    const { capture } = makeCapture();
    const recognitionStart = vi.fn();
    class BrowserRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror = null;
      onend = null;
      start = recognitionStart;
      stop = vi.fn();
      abort = vi.fn();
    }
    Object.defineProperty(globalThis, "SpeechRecognition", {
      configurable: true,
      value: BrowserRecognition
    });

    function Harness() {
      const voice = useEditableDictation({
        capture,
        authoritativeTranscribe: async () => ({ text: "batch only" })
      });
      return (
        <div>
          <output aria-label="opt-in-state">{voice.state}</output>
          <output aria-label="opt-in-mode">{voice.recognitionMode}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            opt-in-start
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "opt-in-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("opt-in-state").textContent).toBe("listening")
    );
    expect(screen.getByLabelText("opt-in-mode").textContent).toBe("batch-only");
    expect(recognitionStart).not.toHaveBeenCalled();
    Reflect.deleteProperty(globalThis, "SpeechRecognition");
  });

  it("cancels a provider that resolves after capture already finalized", async () => {
    const captured = deferred<CapturedAudio>();
    const captureSession: VoiceCaptureSession = {
      active: true,
      result: captured.promise,
      stop: vi.fn(() => captured.promise),
      cancel: vi.fn()
    };
    const capture: VoiceCaptureController = {
      start: vi.fn(async () => captureSession),
      cancel: vi.fn(),
      dispose: vi.fn()
    };
    const providerStart = deferred<DictationProviderSession>();
    const lateSession: DictationProviderSession = {
      active: true,
      result: new Promise<void>(() => undefined),
      stop: vi.fn(() => new Promise<void>(() => undefined)),
      cancel: vi.fn()
    };
    const provider: DictationProvider = { start: vi.fn(() => providerStart.promise) };

    function Harness() {
      const voice = useEditableDictation({
        capture,
        provider,
        authoritativeTranscribe: async () => ({ text: "finalized batch" })
      });
      return (
        <div>
          <output aria-label="late-provider-state">{voice.state}</output>
          <output aria-label="late-provider-value">{voice.value}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            late-provider-start
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "late-provider-start" }));
    captured.resolve({ ...audio, terminationReason: "max-duration" });
    await waitFor(() =>
      expect(screen.getByLabelText("late-provider-state").textContent).toBe("review")
    );
    providerStart.resolve(lateSession);
    await waitFor(() => expect(lateSession.cancel).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("late-provider-state").textContent).toBe("review");
    expect(screen.getByLabelText("late-provider-value").textContent).toBe("finalized batch");
  });

  it("reconciles a late batch transcript against edits made while transcribing", async () => {
    const { capture } = makeCapture();
    const transcript = deferred<{ text: string }>();

    function Harness() {
      const voice = useEditableDictation({
        defaultValue: "starting thought",
        capture,
        authoritativeTranscribe: () => transcript.promise
      });
      return (
        <div>
          <textarea
            aria-label="late-batch-draft"
            value={voice.value}
            onChange={(event) => voice.setValue(event.currentTarget.value)}
          />
          <output aria-label="late-batch-state">{voice.state}</output>
          <output aria-label="late-batch-suggestion">{voice.authoritativeSuggestion}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            late-batch-start
          </button>
          <button type="button" onClick={voice.stopDictation}>
            late-batch-stop
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "late-batch-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("late-batch-state").textContent).toBe("listening")
    );
    fireEvent.click(screen.getByRole("button", { name: "late-batch-stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("late-batch-state").textContent).toBe("transcribing")
    );
    fireEvent.change(screen.getByLabelText("late-batch-draft"), {
      target: { value: "edit made during transcription" }
    });
    transcript.resolve({ text: "authoritative late transcript" });

    await waitFor(() =>
      expect(screen.getByLabelText("late-batch-state").textContent).toBe("review")
    );
    expect((screen.getByLabelText("late-batch-draft") as HTMLTextAreaElement).value).toBe(
      "edit made during transcription"
    );
    expect(screen.getByLabelText("late-batch-suggestion").textContent).toBe(
      "authoritative late transcript"
    );
  });

  it("aborts pending provider startup after a fatal capture failure", async () => {
    const captured = deferred<CapturedAudio>();
    const providerStart = deferred<DictationProviderSession>();
    let providerInput: DictationProviderStartInput | null = null;
    const lateSession: DictationProviderSession = {
      active: true,
      result: new Promise<void>(() => undefined),
      stop: vi.fn(() => new Promise<void>(() => undefined)),
      cancel: vi.fn()
    };
    const captureSession: VoiceCaptureSession = {
      active: true,
      result: captured.promise,
      stop: vi.fn(() => captured.promise),
      cancel: vi.fn()
    };
    const capture: VoiceCaptureController = {
      start: vi.fn(async () => captureSession),
      cancel: vi.fn(),
      dispose: vi.fn()
    };
    const provider: DictationProvider = {
      start: vi.fn((input) => {
        providerInput = input;
        return providerStart.promise;
      })
    };

    function Harness() {
      const voice = useEditableDictation({
        defaultValue: "protected value",
        capture,
        provider,
        authoritativeTranscribe: vi.fn()
      });
      return (
        <div>
          <output aria-label="capture-failure-state">{voice.state}</output>
          <output aria-label="capture-failure-value">{voice.value}</output>
          <button type="button" onClick={() => void voice.startDictation()}>
            capture-failure-start
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "capture-failure-start" }));
    await waitFor(() => expect(providerInput).not.toBeNull());
    captured.reject(new Error("synthetic capture failure"));
    await waitFor(() =>
      expect(screen.getByLabelText("capture-failure-state").textContent).toBe("error")
    );
    expect(providerInput!.signal?.aborted).toBe(true);
    providerInput!.onResult({ transcript: "must not be applied", isFinal: true });
    expect(screen.getByLabelText("capture-failure-value").textContent).toBe(
      "protected value"
    );

    providerStart.resolve(lateSession);
    await waitFor(() => expect(lateSession.cancel).toHaveBeenCalledOnce());
  });
});

describe("useDirectAudioMessage", () => {
  it("cancels pending microphone permission and can retry immediately", async () => {
    const pending = makePendingCapture();
    const firstSession = inertCaptureSession();
    const secondSession = inertCaptureSession();
    const transport: DirectAudioUploadTransport = { upload: vi.fn() };

    function Harness() {
      const voice = useDirectAudioMessage({ capture: pending.capture, transport });
      return (
        <div>
          <output aria-label="pending-audio-state">{voice.state}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            pending-audio-start
          </button>
          <button type="button" onClick={voice.cancel}>
            pending-audio-cancel
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "pending-audio-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("pending-audio-state").textContent).toBe(
        "requesting-permission"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "pending-audio-cancel" }));
    expect(pending.capture.cancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "pending-audio-start" }));
    expect(pending.capture.start).toHaveBeenCalledTimes(2);
    pending.secondStart.resolve(secondSession);
    await waitFor(() =>
      expect(screen.getByLabelText("pending-audio-state").textContent).toBe("recording")
    );

    pending.firstStart.resolve(firstSession);
    await waitFor(() => expect(firstSession.cancel).toHaveBeenCalledOnce());
  });

  it("keeps same-tick double starts single-flight before React can rerender", async () => {
    const { capture } = makeCapture();
    const transport: DirectAudioUploadTransport = { upload: vi.fn() };

    function Harness() {
      const voice = useDirectAudioMessage({ capture, transport });
      return (
        <button
          type="button"
          onClick={() => {
            void voice.startRecording();
            void voice.startRecording();
          }}
        >
          double-record
        </button>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "double-record" }));
    await waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
  });

  it("keeps the existing unsent recording when a re-record start fails", async () => {
    const first = makeCapture();
    const capture: VoiceCaptureController = {
      start: vi
        .fn<VoiceCaptureController["start"]>()
        .mockResolvedValueOnce(first.session)
        .mockRejectedValueOnce(
          new VoiceInputError("permission-denied", "Synthetic permission denial.")
        ),
      cancel: vi.fn(),
      dispose: vi.fn()
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport: { upload: vi.fn() }
      });
      return (
        <div>
          <output aria-label="rerecord-state">{voice.state}</output>
          <output aria-label="rerecord-size">{voice.audio?.size}</output>
          <output aria-label="rerecord-url">{voice.audioUrl}</output>
          <output aria-label="rerecord-error">{voice.error?.code}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            rerecord-start
          </button>
          <button type="button" onClick={voice.stopRecording}>
            rerecord-stop
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "rerecord-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("rerecord-state").textContent).toBe("recording")
    );
    fireEvent.click(screen.getByRole("button", { name: "rerecord-stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("rerecord-state").textContent).toBe("ready")
    );
    const preservedUrl = screen.getByLabelText("rerecord-url").textContent;

    fireEvent.click(screen.getByRole("button", { name: "rerecord-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("rerecord-state").textContent).toBe("error")
    );
    expect(screen.getByLabelText("rerecord-error").textContent).toBe("permission-denied");
    expect(screen.getByLabelText("rerecord-size").textContent).toBe(String(audio.size));
    expect(screen.getByLabelText("rerecord-url").textContent).toBe(preservedUrl);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("uploads a captured recording once and exposes playable server metadata", async () => {
    const { capture } = makeCapture();
    const upload = deferred<Awaited<ReturnType<DirectAudioUploadTransport["upload"]>>>();
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(() => upload.promise)
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport,
        createClientMessageId: () => "anonymous-client-message"
      });
      return (
        <div>
          <output aria-label="state">{voice.state}</output>
          <output aria-label="remote-url">{voice.message?.audio.url}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            record
          </button>
          <button type="button" onClick={voice.stopRecording}>
            stop
          </button>
          <button type="button" onClick={() => void voice.send()}>
            send
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "record" }));
    await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("ready"));

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(transport.upload).toHaveBeenCalledOnce();
    expect(transport.upload).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: "anonymous-client-message", audio })
    );

    upload.resolve({
      id: "anonymous-server-message",
      clientMessageId: "anonymous-client-message",
      kind: "audio",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        url: "https://media.example.test/audio/anonymous-message.webm",
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
        size: audio.size
      }
    });
    await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("sent"));
    expect(screen.getByLabelText("remote-url").textContent).toContain("anonymous-message.webm");
  });

  it("can opt into upload-on-stop without requiring a second user action", async () => {
    const { capture } = makeCapture();
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async ({ audio: captured, clientMessageId }) => ({
        id: "anonymous-auto-message",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/anonymous-auto-message.webm",
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          size: captured.size
        }
      }))
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport,
        uploadOnStop: true,
        createClientMessageId: () => "anonymous-auto-client"
      });
      return (
        <div>
          <output aria-label="auto-state">{voice.state}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            auto-record
          </button>
          <button type="button" onClick={voice.stopRecording}>
            auto-stop
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "auto-record" }));
    await waitFor(() => expect(screen.getByLabelText("auto-state").textContent).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "auto-stop" }));
    await waitFor(() => expect(screen.getByLabelText("auto-state").textContent).toBe("sent"));
    expect(transport.upload).toHaveBeenCalledOnce();
  });

  it("does not auto-upload audio stopped by page lifecycle", async () => {
    const completion = deferred<CapturedAudio>();
    const session: VoiceCaptureSession = {
      active: true,
      result: completion.promise,
      stop: vi.fn(() => completion.promise),
      cancel: vi.fn()
    };
    const capture: VoiceCaptureController = {
      start: vi.fn(async () => session),
      cancel: vi.fn(),
      dispose: vi.fn()
    };
    const transport: DirectAudioUploadTransport = { upload: vi.fn() };

    function Harness() {
      const voice = useDirectAudioMessage({ capture, transport, uploadOnStop: true });
      return (
        <div>
          <output aria-label="lifecycle-audio-state">{voice.state}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            lifecycle-audio-start
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "lifecycle-audio-start" }));
    await waitFor(() =>
      expect(screen.getByLabelText("lifecycle-audio-state").textContent).toBe("recording")
    );
    completion.resolve({ ...audio, terminationReason: "page-hidden" });
    await waitFor(() =>
      expect(screen.getByLabelText("lifecycle-audio-state").textContent).toBe("ready")
    );
    expect(transport.upload).not.toHaveBeenCalled();
  });

  it("does not write sent after onMessage clears reentrantly", async () => {
    const { capture } = makeCapture();
    let clearCurrent: () => void = () => undefined;
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async ({ audio: captured, clientMessageId }) => ({
        id: "reentrant-message",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/reentrant.webm",
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          size: captured.size
        }
      }))
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport,
        onMessage: () => clearCurrent()
      });
      clearCurrent = voice.clear;
      return (
        <div>
          <output aria-label="reentrant-state">{voice.state}</output>
          <output aria-label="reentrant-message">{voice.message?.id}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            reentrant-record
          </button>
          <button type="button" onClick={voice.stopRecording}>
            reentrant-stop
          </button>
          <button type="button" onClick={() => void voice.send()}>
            reentrant-send
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "reentrant-record" }));
    await waitFor(() => expect(screen.getByLabelText("reentrant-state").textContent).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "reentrant-stop" }));
    await waitFor(() => expect(screen.getByLabelText("reentrant-state").textContent).toBe("ready"));
    fireEvent.click(screen.getByRole("button", { name: "reentrant-send" }));

    await waitFor(() => expect(screen.getByLabelText("reentrant-state").textContent).toBe("idle"));
    expect(screen.getByLabelText("reentrant-message").textContent).toBe("");
  });

  it("keeps a confirmed sent receipt when the host onMessage callback throws", async () => {
    const { capture } = makeCapture();
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async ({ audio: captured, clientMessageId }) => ({
        id: "callback-error-message",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/callback-error.webm",
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          size: captured.size
        }
      }))
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport,
        onMessage: () => {
          throw new Error("host callback failed");
        }
      });
      return (
        <div>
          <output aria-label="callback-error-state">{voice.state}</output>
          <output aria-label="callback-error-message">{voice.message?.id}</output>
          <output aria-label="callback-host-error">{voice.callbackError?.message}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            callback-error-record
          </button>
          <button type="button" onClick={voice.stopRecording}>
            callback-error-stop
          </button>
          <button type="button" onClick={() => void voice.send()}>
            callback-error-send
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "callback-error-record" }));
    await waitFor(() =>
      expect(screen.getByLabelText("callback-error-state").textContent).toBe("recording")
    );
    fireEvent.click(screen.getByRole("button", { name: "callback-error-stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("callback-error-state").textContent).toBe("ready")
    );
    fireEvent.click(screen.getByRole("button", { name: "callback-error-send" }));

    await waitFor(() =>
      expect(screen.getByLabelText("callback-error-state").textContent).toBe("sent")
    );
    expect(screen.getByLabelText("callback-error-message").textContent).toBe(
      "callback-error-message"
    );
    expect(screen.getByLabelText("callback-host-error").textContent).toBe(
      "host callback failed"
    );
    fireEvent.click(screen.getByRole("button", { name: "callback-error-send" }));
    expect(transport.upload).toHaveBeenCalledOnce();
  });

  it("contains rejected async host callbacks after a confirmed send", async () => {
    const { capture } = makeCapture();
    const onCallbackError = vi.fn(async () => {
      throw new Error("secondary callback rejection");
    });
    const transport: DirectAudioUploadTransport = {
      upload: vi.fn(async ({ audio: captured, clientMessageId }) => ({
        id: "async-callback-message",
        clientMessageId,
        kind: "audio" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://media.example.test/audio/async-callback.webm",
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          size: captured.size
        }
      }))
    };

    function Harness() {
      const voice = useDirectAudioMessage({
        capture,
        transport,
        onMessage: async () => {
          throw new Error("async host callback failed");
        },
        onCallbackError
      });
      return (
        <div>
          <output aria-label="async-callback-state">{voice.state}</output>
          <output aria-label="async-callback-error">{voice.callbackError?.message}</output>
          <button type="button" onClick={() => void voice.startRecording()}>
            async-callback-record
          </button>
          <button type="button" onClick={voice.stopRecording}>
            async-callback-stop
          </button>
          <button type="button" onClick={() => void voice.send()}>
            async-callback-send
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "async-callback-record" }));
    await waitFor(() =>
      expect(screen.getByLabelText("async-callback-state").textContent).toBe("recording")
    );
    fireEvent.click(screen.getByRole("button", { name: "async-callback-stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("async-callback-state").textContent).toBe("ready")
    );
    fireEvent.click(screen.getByRole("button", { name: "async-callback-send" }));

    await waitFor(() =>
      expect(screen.getByLabelText("async-callback-error").textContent).toBe(
        "async host callback failed"
      )
    );
    expect(screen.getByLabelText("async-callback-state").textContent).toBe("sent");
    expect(onCallbackError).toHaveBeenCalledOnce();
  });
});

describe("DualModeVoiceInput", () => {
  it("serializes same-tick headless starts so only one microphone mode begins", async () => {
    const dictationCapture = makeCapture().capture;
    const directCapture = makeCapture().capture;

    function Harness() {
      const voice = useDualModeVoiceInput({
        dictation: {
          capture: dictationCapture,
          authoritativeTranscribe: async () => ({ text: "synthetic transcript" })
        },
        directAudio: {
          capture: directCapture,
          transport: { upload: vi.fn() }
        }
      });
      return (
        <div>
          <output aria-label="headless-mode">{voice.mode}</output>
          <button
            type="button"
            onClick={() => {
              void voice.dictation.startDictation();
              void voice.directAudio.startRecording();
            }}
          >
            concurrent-headless-start
          </button>
          <button type="button" onClick={voice.dictation.cancel}>
            cancel-headless
          </button>
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "concurrent-headless-start" }));
    await waitFor(() => expect(dictationCapture.start).toHaveBeenCalledOnce());
    expect(directCapture.start).not.toHaveBeenCalled();
    expect(screen.getByLabelText("headless-mode").textContent).toBe("dictation");
    fireEvent.click(screen.getByRole("button", { name: "cancel-headless" }));
  });

  it("exposes keyboard-operable tabs for both voice contracts", async () => {
    const dictationCapture = makeCapture().capture;
    const directCapture = makeCapture().capture;
    render(
      <DualModeVoiceInput
        dictation={{
          capture: dictationCapture,
          authoritativeTranscribe: async () => ({ text: "synthetic transcript" })
        }}
        directAudio={{
          capture: directCapture,
          transport: { upload: vi.fn() }
        }}
      />
    );
    const editTab = screen.getByRole("tab", { name: "Edit text" });
    const audioTab = screen.getByRole("tab", { name: "Send recording" });
    expect(editTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editTab, { key: "ArrowRight" });
    await waitFor(() => expect(audioTab.getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(audioTab));
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Recording"));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
});
