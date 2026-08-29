import {
  BrowserVoiceCapture,
  ObjectUrlLease,
  VoiceInputError,
  mergeTranscriptDraft,
  transcriptionText,
  type CapturedAudio,
  type MergeTranscriptOptions,
  type Transcriber,
  type VoiceCaptureOptions,
  type VoiceCaptureSession,
  type VoiceInputState,
  type VoiceSubmission
} from "@editable-voice-input/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceCaptureController } from "./capture-controller";

export type { VoiceCaptureController } from "./capture-controller";

export interface UseVoiceInputOptions {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onAudioReady?: (audio: CapturedAudio | null) => void;
  onSubmit?: (submission: VoiceSubmission) => void | Promise<void>;
  transcribe: Transcriber;
  language?: string;
  merge?: MergeTranscriptOptions;
  captureOptions?: VoiceCaptureOptions;
  capture?: VoiceCaptureController;
}

export interface UseVoiceInputResult {
  value: string;
  setValue(value: string): void;
  state: VoiceInputState;
  error: VoiceInputError | null;
  elapsedMs: number;
  audio: CapturedAudio | null;
  audioUrl: string | null;
  startRecording(): Promise<void>;
  stopRecording(): void;
  cancel(): void;
  clearRecording(): void;
  submit(): Promise<void>;
}

function asVoiceError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  return new VoiceInputError("transcription-failed", "Voice transcription failed.", {
    cause: error
  });
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [uncontrolledValue, setUncontrolledValue] = useState(options.defaultValue ?? "");
  const controlled = options.value !== undefined;
  const value = options.value ?? uncontrolledValue;
  const valueRef = useRef(value);
  valueRef.current = value;

  const [state, setState] = useState<VoiceInputState>("idle");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audio, setAudio] = useState<CapturedAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const sessionRef = useRef<VoiceCaptureSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const submitInFlightRef = useRef(false);
  const captureRef = useRef<VoiceCaptureController | null>(null);
  if (!captureRef.current) {
    captureRef.current = options.capture ?? new BrowserVoiceCapture(options.captureOptions);
  }
  const objectUrls = useMemo(() => new ObjectUrlLease(), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const updateValue = useCallback(
    (next: string) => {
      valueRef.current = next;
      if (!controlled) setUncontrolledValue(next);
      options.onValueChange?.(next);
    },
    [controlled, options.onValueChange]
  );

  const replaceAudio = useCallback(
    (next: CapturedAudio | null) => {
      setAudio(next);
      setAudioUrl(objectUrls.replace(next?.blob ?? null));
      options.onAudioReady?.(next);
    },
    [objectUrls, options.onAudioReady]
  );

  const handleCaptureError = useCallback(
    (caught: unknown, requestId: number) => {
      if (requestId !== requestIdRef.current) return;
      stopTimer();
      sessionRef.current = null;
      const nextError = asVoiceError(caught);
      if (nextError.code === "capture-cancelled") {
        setState("idle");
        return;
      }
      setError(nextError);
      setState("error");
    },
    [stopTimer]
  );

  const handleCaptured = useCallback(
    async (captured: CapturedAudio, requestId: number) => {
      if (requestId !== requestIdRef.current) return;
      stopTimer();
      sessionRef.current = null;
      replaceAudio(captured);
      setState("transcribing");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await options.transcribe({
          ...captured,
          ...(options.language ? { language: options.language } : {}),
          signal: controller.signal
        });
        if (requestId !== requestIdRef.current) return;
        const transcript = transcriptionText(result).trim();
        if (!transcript) {
          throw new VoiceInputError(
            "transcription-failed",
            "The transcription service returned an empty transcript."
          );
        }
        updateValue(mergeTranscriptDraft(valueRef.current, transcript, options.merge));
        setError(null);
        setState("review");
      } catch (caught) {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setError(asVoiceError(caught));
        setState("error");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [options.language, options.merge, options.transcribe, replaceAudio, stopTimer, updateValue]
  );

  const startRecording = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    stopTimer();
    replaceAudio(null);
    setError(null);
    setElapsedMs(0);
    setState("requesting-permission");
    try {
      const session = await captureRef.current!.start();
      if (requestId !== requestIdRef.current) {
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
        (result) => handleCaptured(result, requestId),
        (caught) => handleCaptureError(caught, requestId)
      );
    } catch (caught) {
      handleCaptureError(caught, requestId);
    }
  }, [handleCaptureError, handleCaptured, replaceAudio, stopTimer]);

  const stopRecording = useCallback(() => {
    if (!sessionRef.current) return;
    stopTimer();
    setState("transcribing");
    void sessionRef.current.stop().catch(() => {
      // The shared result promise reports this through handleCaptureError.
    });
  }, [stopTimer]);

  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopTimer();
    sessionRef.current?.cancel();
    sessionRef.current = null;
    replaceAudio(null);
    setError(null);
    setElapsedMs(0);
    setState("idle");
  }, [replaceAudio, stopTimer]);

  const clearRecording = useCallback(() => {
    replaceAudio(null);
    setError(null);
    if (state !== "recording" && state !== "requesting-permission" && state !== "transcribing") {
      setState("idle");
    }
  }, [replaceAudio, state]);

  const submit = useCallback(async () => {
    const text = valueRef.current.trim();
    if (
      !text ||
      !options.onSubmit ||
      submitInFlightRef.current ||
      state === "recording" ||
      state === "transcribing" ||
      state === "requesting-permission"
    ) {
      return;
    }
    submitInFlightRef.current = true;
    setError(null);
    setState("submitting");
    try {
      await options.onSubmit({ text, audio });
      setState(audio ? "review" : "idle");
    } catch (caught) {
      setError(
        caught instanceof VoiceInputError
          ? caught
          : new VoiceInputError("submission-failed", "Voice submission failed.", {
              cause: caught
            })
      );
      setState("error");
    } finally {
      submitInFlightRef.current = false;
    }
  }, [audio, options.onSubmit, state]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      submitInFlightRef.current = false;
      abortRef.current?.abort();
      stopTimer();
      captureRef.current?.dispose();
      objectUrls.revoke();
    };
  }, [objectUrls, stopTimer]);

  return {
    value,
    setValue: updateValue,
    state,
    error,
    elapsedMs,
    audio,
    audioUrl,
    startRecording,
    stopRecording,
    cancel,
    clearRecording,
    submit
  };
}
