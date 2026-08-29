import {
  BrowserVoiceCapture,
  ObjectUrlLease,
  VoiceInputError,
  uploadDirectAudioMessage,
  type CapturedAudio,
  type DirectAudioMessage,
  type DirectAudioUploadTransport,
  type VoiceCaptureOptions,
  type VoiceCaptureSession
} from "@editable-voice-input/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceCaptureController } from "./capture-controller";

export type DirectAudioMessageState =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "stopping"
  | "ready"
  | "uploading"
  | "sent"
  | "error";

export interface UseDirectAudioMessageOptions {
  transport: DirectAudioUploadTransport;
  metadata?: Readonly<Record<string, string>>;
  uploadOnStop?: boolean;
  createClientMessageId?: () => string;
  onAudioReady?: (audio: CapturedAudio | null) => void;
  onMessage?: (message: DirectAudioMessage) => void;
  captureOptions?: VoiceCaptureOptions;
  capture?: VoiceCaptureController;
}

export interface UseDirectAudioMessageResult {
  state: DirectAudioMessageState;
  error: VoiceInputError | null;
  elapsedMs: number;
  audio: CapturedAudio | null;
  audioUrl: string | null;
  message: DirectAudioMessage | null;
  startRecording(): Promise<void>;
  stopRecording(): void;
  send(): Promise<void>;
  cancel(): void;
  clear(): void;
}

let fallbackMessageCounter = 0;

function defaultClientMessageId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  fallbackMessageCounter += 1;
  return `voice-${Date.now().toString(36)}-${fallbackMessageCounter.toString(36)}`;
}

function asCaptureError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  return new VoiceInputError("recording-failed", "Voice recording failed.", { cause: error });
}

function asUploadError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  return new VoiceInputError("submission-failed", "Audio message upload failed.", {
    cause: error
  });
}

export function useDirectAudioMessage(
  options: UseDirectAudioMessageOptions
): UseDirectAudioMessageResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<DirectAudioMessageState>("idle");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audio, setAudio] = useState<CapturedAudio | null>(null);
  const audioRef = useRef<CapturedAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<DirectAudioMessage | null>(null);
  const captureRef = useRef<VoiceCaptureController | null>(null);
  if (!captureRef.current) {
    captureRef.current = options.capture ?? new BrowserVoiceCapture(options.captureOptions);
  }
  const sessionRef = useRef<VoiceCaptureSession | null>(null);
  const startInFlightRef = useRef(false);
  const operationIdRef = useRef(0);
  const uploadAttemptIdRef = useRef(0);
  const activeUploadAttemptRef = useRef<number | null>(null);
  const clientMessageIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const objectUrls = useMemo(() => new ObjectUrlLease(), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const replaceAudio = useCallback(
    (next: CapturedAudio | null) => {
      audioRef.current = next;
      setAudio(next);
      setAudioUrl(objectUrls.replace(next?.blob ?? null));
      optionsRef.current.onAudioReady?.(next);
    },
    [objectUrls]
  );

  const uploadRef = useRef<(captured: CapturedAudio, operationId: number) => Promise<void>>(
    async () => undefined
  );

  uploadRef.current = async (captured, operationId) => {
    if (activeUploadAttemptRef.current !== null || operationId !== operationIdRef.current) return;
    const uploadAttemptId = uploadAttemptIdRef.current + 1;
    uploadAttemptIdRef.current = uploadAttemptId;
    activeUploadAttemptRef.current = uploadAttemptId;
    setError(null);
    setState("uploading");
    const controller = new AbortController();
    abortRef.current = controller;
    const currentOptions = optionsRef.current;
    const clientMessageId =
      clientMessageIdRef.current ??
      (currentOptions.createClientMessageId ?? defaultClientMessageId)();
    clientMessageIdRef.current = clientMessageId;

    try {
      const uploaded = await uploadDirectAudioMessage(currentOptions.transport, {
        clientMessageId,
        audio: captured,
        ...(currentOptions.metadata ? { metadata: currentOptions.metadata } : {}),
        signal: controller.signal
      });
      if (operationId !== operationIdRef.current) return;
      currentOptions.onMessage?.(uploaded);
      if (operationId !== operationIdRef.current) return;
      setMessage(uploaded);
      setState("sent");
    } catch (caught) {
      if (operationId !== operationIdRef.current || controller.signal.aborted) return;
      setError(asUploadError(caught));
      setState("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (activeUploadAttemptRef.current === uploadAttemptId) {
        activeUploadAttemptRef.current = null;
      }
    }
  };

  const handleCaptured = useCallback(
    (captured: CapturedAudio, operationId: number) => {
      if (operationId !== operationIdRef.current) return;
      stopTimer();
      sessionRef.current = null;
      replaceAudio(captured);
      clientMessageIdRef.current =
        (optionsRef.current.createClientMessageId ?? defaultClientMessageId)();
      setError(null);
      setState("ready");
      if (optionsRef.current.uploadOnStop) {
        void uploadRef.current(captured, operationId);
      }
    },
    [replaceAudio, stopTimer]
  );

  const handleCaptureError = useCallback(
    (caught: unknown, operationId: number) => {
      if (operationId !== operationIdRef.current) return;
      stopTimer();
      sessionRef.current = null;
      const nextError = asCaptureError(caught);
      if (nextError.code === "capture-cancelled") {
        setState("idle");
        return;
      }
      setError(nextError);
      setState("error");
    },
    [stopTimer]
  );

  const startRecording = useCallback(async () => {
    if (
      startInFlightRef.current ||
      activeUploadAttemptRef.current !== null ||
      sessionRef.current?.active ||
      state === "requesting-permission" ||
      state === "stopping" ||
      state === "uploading"
    ) {
      return;
    }
    startInFlightRef.current = true;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    abortRef.current?.abort();
    activeUploadAttemptRef.current = null;
    clientMessageIdRef.current = null;
    replaceAudio(null);
    setMessage(null);
    setError(null);
    setElapsedMs(0);
    setState("requesting-permission");

    try {
      const session = await captureRef.current!.start();
      if (operationId !== operationIdRef.current) {
        void session.result.catch(() => {
          // This session is intentionally stale and is cancelled below.
        });
        session.cancel();
        return;
      }
      sessionRef.current = session;
      startedAtRef.current = Date.now();
      setState("recording");
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
      void session.result.then(
        (captured) => handleCaptured(captured, operationId),
        (caught) => handleCaptureError(caught, operationId)
      );
    } catch (caught) {
      handleCaptureError(caught, operationId);
    } finally {
      if (operationId === operationIdRef.current) startInFlightRef.current = false;
    }
  }, [handleCaptureError, handleCaptured, replaceAudio, state]);

  const stopRecording = useCallback(() => {
    if (!sessionRef.current) return;
    stopTimer();
    setState("stopping");
    void sessionRef.current.stop().catch(() => {
      // The shared result promise reports this through handleCaptureError.
    });
  }, [stopTimer]);

  const send = useCallback(async () => {
    const captured = audioRef.current;
    if (!captured) return;
    await uploadRef.current(captured, operationIdRef.current);
  }, []);

  const clear = useCallback(() => {
    operationIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    activeUploadAttemptRef.current = null;
    startInFlightRef.current = false;
    stopTimer();
    captureRef.current?.cancel();
    sessionRef.current?.cancel();
    sessionRef.current = null;
    clientMessageIdRef.current = null;
    replaceAudio(null);
    setMessage(null);
    setElapsedMs(0);
    setError(null);
    setState("idle");
  }, [replaceAudio, stopTimer]);

  const cancel = clear;

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      startInFlightRef.current = false;
      abortRef.current?.abort();
      stopTimer();
      sessionRef.current?.cancel();
      captureRef.current?.dispose();
      objectUrls.revoke();
    };
  }, [objectUrls, stopTimer]);

  return {
    state,
    error,
    elapsedMs,
    audio,
    audioUrl,
    message,
    startRecording,
    stopRecording,
    send,
    cancel,
    clear
  };
}
