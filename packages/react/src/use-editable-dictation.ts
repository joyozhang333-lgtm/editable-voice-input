import {
  BrowserVoiceCapture,
  BrowserWebSpeechDictationProvider,
  ObjectUrlLease,
  VoiceInputError,
  applyDictationEdit,
  applyDictationResult,
  createEditableDictationDraft,
  reconcileAuthoritativeDictation,
  transcriptionText,
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
  /**
   * Explicitly opts into the browser-vendor Web Speech service when no provider
   * is injected. Defaults to false because implementations may process audio remotely.
   */
  enableBrowserWebSpeech?: boolean;
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
  /** Non-fatal live-recognition failure while batch recording continues. */
  liveError: VoiceInputError | null;
  recognitionMode: "live" | "batch-only";
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
  const [liveError, setLiveError] = useState<VoiceInputError | null>(null);
  const [recognitionMode, setRecognitionMode] = useState<"live" | "batch-only">(
    options.provider || options.enableBrowserWebSpeech ? "live" : "batch-only"
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audio, setAudio] = useState<CapturedAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const browserProviderRef = useRef<DictationProvider | null>(null);
  if (!browserProviderRef.current && options.enableBrowserWebSpeech && !options.provider) {
    browserProviderRef.current = new BrowserWebSpeechDictationProvider();
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
  const providerStartAbortRef = useRef<AbortController | null>(null);
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
      providerStartAbortRef.current?.abort();
      providerStartAbortRef.current = null;
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
    providerStartAbortRef.current?.abort();
    providerStartAbortRef.current = null;
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
      const [, captured] = await Promise.all([
        captureSession
          ? providerCompletion.catch((caught) => {
              setLiveError(asDictationError(caught));
              setRecognitionMode("batch-only");
            })
          : providerCompletion,
        captureCompletion
      ]);
      if (operationId !== operationIdRef.current) return;

      dictationSessionRef.current = null;
      captureSessionRef.current = null;
      if (captured) replaceAudio(captured);

      const currentOptions = optionsRef.current;
      const maySendForBatch =
        captured?.terminationReason === undefined ||
        captured.terminationReason === "user-stop" ||
        captured.terminationReason === "max-duration";
      if (captured && currentOptions.authoritativeTranscribe && maySendForBatch) {
        setState("transcribing");
        const controller = new AbortController();
        abortRef.current = controller;
        const result = await currentOptions.authoritativeTranscribe({
          ...captured,
          ...(currentOptions.language ? { language: currentOptions.language } : {}),
          signal: controller.signal
        });
        if (operationId !== operationIdRef.current) return;
        // Reconcile only after the network boundary: the textarea remains
        // editable while batch transcription is running.
        const outcome = reconcileAuthoritativeDictation(
          draftRef.current,
          transcriptionText(result),
          currentOptions.merge ? { merge: currentOptions.merge } : {}
        );
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
    setLiveError(null);
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

      const provider =
        currentOptions.provider ??
        (currentOptions.enableBrowserWebSpeech
          ? (browserProviderRef.current ??= new BrowserWebSpeechDictationProvider())
          : null);
      if (!provider && !captureSession) {
        throw new VoiceInputError(
          "unsupported-browser",
          "Configure a dictation provider, explicitly opt into browser Web Speech, or provide batch transcription."
        );
      }

      let dictationSession: DictationProviderSession | null = null;
      if (provider) {
        const providerController = new AbortController();
        providerStartAbortRef.current = providerController;
        try {
          dictationSession = await provider.start({
            ...(currentOptions.language ? { language: currentOptions.language } : {}),
            signal: providerController.signal,
            onResult: (result) => {
              if (providerController.signal.aborted || operationId !== operationIdRef.current) {
                return;
              }
              commitDraft(
                applyDictationResult(draftRef.current, result, {
                  ...(optionsRef.current.merge ? { merge: optionsRef.current.merge } : {})
                })
              );
            }
          });
          if (
            operationId !== operationIdRef.current ||
            finalizingOperationRef.current === operationId ||
            (captureSession !== null && captureSessionRef.current !== captureSession)
          ) {
            void dictationSession.result.catch(() => {
              // A provider that resolved after capture completion is intentionally detached.
            });
            dictationSession.cancel();
            return;
          }
          setRecognitionMode("live");
        } catch (caught) {
          if (
            operationId !== operationIdRef.current ||
            finalizingOperationRef.current === operationId ||
            (captureSession !== null && captureSessionRef.current !== captureSession)
          ) {
            return;
          }
          if (!captureSession) throw caught;
          setLiveError(asDictationError(caught));
          setRecognitionMode("batch-only");
        } finally {
          if (providerStartAbortRef.current === providerController) {
            providerStartAbortRef.current = null;
          }
        }
      } else {
        setRecognitionMode("batch-only");
      }

      if (operationId !== operationIdRef.current) {
        if (dictationSession) {
          void dictationSession.result.catch(() => {
            // This session is intentionally stale and is cancelled below.
          });
          dictationSession.cancel();
        }
        captureSession?.cancel();
        return;
      }
      dictationSessionRef.current = dictationSession;
      startedAtRef.current = Date.now();
      setState("listening");
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);

      if (dictationSession) {
        void dictationSession.result.then(
          () => {
            if (operationId !== operationIdRef.current) return;
            dictationSessionRef.current = null;
            if (captureSessionRef.current?.active) {
              setRecognitionMode("batch-only");
              return;
            }
            void finishOperationRef.current(operationId, true);
          },
          (caught) => {
            if (operationId !== operationIdRef.current) return;
            dictationSessionRef.current = null;
            if (captureSessionRef.current?.active) {
              setLiveError(asDictationError(caught));
              setRecognitionMode("batch-only");
              return;
            }
            failOperation(caught, operationId);
          }
        );
      }
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
    if ((!dictationSessionRef.current && !captureSessionRef.current) || operationId <= 0) return;
    void finishOperationRef.current(operationId, false);
  }, []);

  const cancel = useCallback(() => {
    operationIdRef.current += 1;
    finalizingOperationRef.current = null;
    startInFlightRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    providerStartAbortRef.current?.abort();
    providerStartAbortRef.current = null;
    stopTimer();
    captureControllerRef.current?.cancel();
    dictationSessionRef.current?.cancel();
    captureSessionRef.current?.cancel();
    dictationSessionRef.current = null;
    captureSessionRef.current = null;
    replaceAudio(null);
    setElapsedMs(0);
    setError(null);
    setLiveError(null);
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
      providerStartAbortRef.current?.abort();
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
    liveError,
    recognitionMode,
    elapsedMs,
    audio,
    audioUrl,
    startDictation,
    stopDictation,
    cancel,
    clearAudio
  };
}
