import {
  BrowserVoiceCapture,
  BrowserWebSpeechDictationProvider,
  ObjectUrlLease,
  VoiceInputError,
  applyDictationEdit,
  applyDictationResult,
  createEditableDictationDraft,
  runAuthoritativeDictationFallback,
  type CapturedAudio,
  type DictationProvider,
  type DictationProviderSession,
  type EditableDictationDraft,
  type MergeTranscriptOptions,
  type Transcriber,
  type VoiceCaptureOptions,
  type VoiceCaptureSession
} from "@editable-voice-input/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceCaptureController } from "./capture-controller";

export type EditableDictationState =
  | "idle"
  | "starting"
  | "listening"
  | "stopping"
  | "transcribing"
  | "review"
  | "error";

export interface UseEditableDictationOptions {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onAudioReady?: (audio: CapturedAudio | null) => void;
  provider?: DictationProvider;
  language?: string;
  merge?: MergeTranscriptOptions;
  /** When present, audio is captured in parallel and batch-transcribed after stop. */
  authoritativeTranscribe?: Transcriber;
  captureOptions?: VoiceCaptureOptions;
  capture?: VoiceCaptureController;
}

export interface UseEditableDictationResult {
  value: string;
  setValue(value: string): void;
  interimText: string;
  committedText: string;
  authoritativeSuggestion: string | null;
  userEdited: boolean;
  state: EditableDictationState;
  error: VoiceInputError | null;
  elapsedMs: number;
  audio: CapturedAudio | null;
  audioUrl: string | null;
  startDictation(): Promise<void>;
  stopDictation(): void;
  cancel(): void;
  clearAudio(): void;
}

function asDictationError(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  return new VoiceInputError("transcription-failed", "Voice dictation failed.", {
    cause: error
  });
}

export function useEditableDictation(
  options: UseEditableDictationOptions = {}
): UseEditableDictationResult {
  const initialValue = options.value ?? options.defaultValue ?? "";
  const [draft, setDraft] = useState<EditableDictationDraft>(() =>
    createEditableDictationDraft(initialValue)
  );
  const draftRef = useRef(draft);
  const visibleValue = options.value ?? draft.value;
  const valueRef = useRef(visibleValue);
  valueRef.current = visibleValue;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<EditableDictationState>("idle");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audio, setAudio] = useState<CapturedAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const providerRef = useRef<DictationProvider | null>(null);
  if (!providerRef.current) {
    providerRef.current = options.provider ?? new BrowserWebSpeechDictationProvider();
  }
  const captureControllerRef = useRef<VoiceCaptureController | null>(null);
  if (!captureControllerRef.current) {
    captureControllerRef.current =
      options.capture ?? new BrowserVoiceCapture(options.captureOptions);
  }

  const dictationSessionRef = useRef<DictationProviderSession | null>(null);
  const captureSessionRef = useRef<VoiceCaptureSession | null>(null);
  const startInFlightRef = useRef(false);
  const operationIdRef = useRef(0);
  const finalizingOperationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const objectUrls = useMemo(() => new ObjectUrlLease(), []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const commitDraft = useCallback((next: EditableDictationDraft, notify = true) => {
    const previousValue = draftRef.current.value;
    draftRef.current = next;
    setDraft(next);
    if (notify && next.value !== previousValue) {
      optionsRef.current.onValueChange?.(next.value);
    }
  }, []);

  const replaceAudio = useCallback(
    (next: CapturedAudio | null) => {
      setAudio(next);
      setAudioUrl(objectUrls.replace(next?.blob ?? null));
      optionsRef.current.onAudioReady?.(next);
    },
    [objectUrls]
  );

  const failOperation = useCallback(
    (caught: unknown, operationId: number) => {
      if (operationId !== operationIdRef.current) return;
      stopTimer();
      dictationSessionRef.current?.cancel();
      dictationSessionRef.current = null;
      captureSessionRef.current?.cancel();
      captureSessionRef.current = null;
      const nextError = asDictationError(caught);
      if (nextError.code === "capture-cancelled") {
        setState("idle");
        return;
      }
      setError(nextError);
      setState("error");
    },
    [stopTimer]
  );

  const finishOperationRef = useRef<
    (operationId: number, providerAlreadyEnded: boolean) => Promise<void>
  >(async () => undefined);

  finishOperationRef.current = async (operationId, providerAlreadyEnded) => {
    if (
      operationId !== operationIdRef.current ||
      finalizingOperationRef.current === operationId
    ) {
      return;
    }
    finalizingOperationRef.current = operationId;
    stopTimer();
    setState("stopping");
    const dictationSession = dictationSessionRef.current;
    const captureSession = captureSessionRef.current;

    try {
      const providerCompletion = dictationSession
        ? providerAlreadyEnded
          ? dictationSession.result
          : dictationSession.stop()
        : Promise.resolve();
      const captureCompletion = captureSession ? captureSession.stop() : Promise.resolve(null);
      const [, captured] = await Promise.all([providerCompletion, captureCompletion]);
      if (operationId !== operationIdRef.current) return;

      dictationSessionRef.current = null;
      captureSessionRef.current = null;
      if (captured) replaceAudio(captured);

      const currentOptions = optionsRef.current;
      if (captured && currentOptions.authoritativeTranscribe) {
        setState("transcribing");
        const controller = new AbortController();
        abortRef.current = controller;
        const outcome = await runAuthoritativeDictationFallback({
          draft: draftRef.current,
          audio: captured,
          transcribe: currentOptions.authoritativeTranscribe,
          ...(currentOptions.language ? { language: currentOptions.language } : {}),
          ...(currentOptions.merge ? { merge: currentOptions.merge } : {}),
          signal: controller.signal
        });
        if (operationId !== operationIdRef.current) return;
        commitDraft(outcome.draft);
      }
      setError(null);
      setState("review");
    } catch (caught) {
      if (operationId === operationIdRef.current && !abortRef.current?.signal.aborted) {
        failOperation(caught, operationId);
      }
    } finally {
      if (operationId === operationIdRef.current) {
        abortRef.current = null;
        finalizingOperationRef.current = null;
      }
    }
  };

  const startDictation = useCallback(async () => {
    if (
      startInFlightRef.current ||
      finalizingOperationRef.current !== null ||
      dictationSessionRef.current?.active ||
      state === "starting" ||
      state === "stopping" ||
      state === "transcribing"
    ) {
      return;
    }
    startInFlightRef.current = true;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    finalizingOperationRef.current = null;
    abortRef.current?.abort();
    replaceAudio(null);
    setError(null);
    setElapsedMs(0);
    setState("starting");
    const freshDraft = createEditableDictationDraft(valueRef.current);
    commitDraft(freshDraft, false);

    try {
      const currentOptions = optionsRef.current;
      let captureSession: VoiceCaptureSession | null = null;
      if (currentOptions.authoritativeTranscribe) {
        captureSession = await captureControllerRef.current!.start();
        if (operationId !== operationIdRef.current) {
          void captureSession.result.catch(() => {
            // This session is intentionally stale and is cancelled below.
          });
          captureSession.cancel();
          return;
        }
        captureSessionRef.current = captureSession;
        void captureSession.result.then(
          () => void finishOperationRef.current(operationId, false),
          (caught) => failOperation(caught, operationId)
        );
      }

      const dictationSession = await providerRef.current!.start({
        ...(currentOptions.language ? { language: currentOptions.language } : {}),
        onResult: (result) => {
          if (operationId !== operationIdRef.current) return;
          commitDraft(
            applyDictationResult(draftRef.current, result, {
              ...(optionsRef.current.merge ? { merge: optionsRef.current.merge } : {})
            })
          );
        }
      });
      if (operationId !== operationIdRef.current) {
        void dictationSession.result.catch(() => {
          // This session is intentionally stale and is cancelled below.
        });
        dictationSession.cancel();
        captureSession?.cancel();
        return;
      }
      dictationSessionRef.current = dictationSession;
      startedAtRef.current = Date.now();
      setState("listening");
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);

      void dictationSession.result.then(
        () => void finishOperationRef.current(operationId, true),
        (caught) => failOperation(caught, operationId)
      );
    } catch (caught) {
      dictationSessionRef.current?.cancel();
      captureSessionRef.current?.cancel();
      failOperation(caught, operationId);
    } finally {
      if (operationId === operationIdRef.current) startInFlightRef.current = false;
    }
  }, [commitDraft, failOperation, replaceAudio, state]);

  const stopDictation = useCallback(() => {
    const operationId = operationIdRef.current;
    if (!dictationSessionRef.current || operationId <= 0) return;
    void finishOperationRef.current(operationId, false);
  }, []);

  const cancel = useCallback(() => {
    operationIdRef.current += 1;
    finalizingOperationRef.current = null;
    startInFlightRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    stopTimer();
    captureControllerRef.current?.cancel();
    dictationSessionRef.current?.cancel();
    captureSessionRef.current?.cancel();
    dictationSessionRef.current = null;
    captureSessionRef.current = null;
    replaceAudio(null);
    setElapsedMs(0);
    setError(null);
    const resetDraft = createEditableDictationDraft(valueRef.current);
    commitDraft(resetDraft, false);
    setState("idle");
  }, [commitDraft, replaceAudio, stopTimer]);

  const setValue = useCallback(
    (next: string) => {
      valueRef.current = next;
      commitDraft(applyDictationEdit(draftRef.current, next));
    },
    [commitDraft]
  );

  const clearAudio = useCallback(() => {
    replaceAudio(null);
  }, [replaceAudio]);

  useEffect(() => {
    if (options.value !== undefined && options.value !== draftRef.current.value) {
      valueRef.current = options.value;
      commitDraft(applyDictationEdit(draftRef.current, options.value), false);
    }
  }, [commitDraft, options.value]);

  useEffect(() => {
    return () => {
      operationIdRef.current += 1;
      startInFlightRef.current = false;
      abortRef.current?.abort();
      stopTimer();
      dictationSessionRef.current?.cancel();
      captureControllerRef.current?.dispose();
      objectUrls.revoke();
    };
  }, [objectUrls, stopTimer]);

  return {
    value: visibleValue,
    setValue,
    interimText: draft.interimText,
    committedText: draft.committedText,
    authoritativeSuggestion: draft.authoritativeSuggestion,
    userEdited: draft.userEdited,
    state,
    error,
    elapsedMs,
    audio,
    audioUrl,
    startDictation,
    stopDictation,
    cancel,
    clearAudio
  };
}
