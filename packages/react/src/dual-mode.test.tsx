// @vitest-environment jsdom

import type {
  CapturedAudio,
  DictationProvider,
  DictationProviderStartInput,
  DictationProviderSession,
  DirectAudioUploadTransport,
  VoiceCaptureSession
} from "@editable-voice-input/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDirectAudioMessage,
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

afterEach(cleanup);

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

  it("keeps an onMessage exception in error state without exposing a message", async () => {
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
      expect(screen.getByLabelText("callback-error-state").textContent).toBe("error")
    );
    expect(screen.getByLabelText("callback-error-message").textContent).toBe("");
  });
});
