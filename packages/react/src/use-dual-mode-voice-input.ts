import { useCallback, useMemo, useRef, useState } from "react";
import {
  useDirectAudioMessage,
  type UseDirectAudioMessageOptions,
  type UseDirectAudioMessageResult
} from "./use-direct-audio-message";
import {
  useEditableDictation,
  type UseEditableDictationOptions,
  type UseEditableDictationResult
} from "./use-editable-dictation";

export type VoiceInputMode = "dictation" | "direct-audio";

export interface UseDualModeVoiceInputOptions {
  dictation: UseEditableDictationOptions;
  directAudio: UseDirectAudioMessageOptions;
  defaultMode?: VoiceInputMode;
  onModeChange?: (mode: VoiceInputMode) => void;
}

export interface UseDualModeVoiceInputResult {
  mode: VoiceInputMode;
  setMode(mode: VoiceInputMode): void;
  dictation: UseEditableDictationResult;
  directAudio: UseDirectAudioMessageResult;
}

/** Headless coordinator that guarantees only one microphone mode remains active. */
export function useDualModeVoiceInput(
  options: UseDualModeVoiceInputOptions
): UseDualModeVoiceInputResult {
  const [mode, setModeState] = useState<VoiceInputMode>(options.defaultMode ?? "dictation");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const startRequestRef = useRef(0);
  const startLockRef = useRef<{ requestId: number; mode: VoiceInputMode } | null>(null);
  const dictation = useEditableDictation(options.dictation);
  const directAudio = useDirectAudioMessage(options.directAudio);

  const activateMode = useCallback((next: VoiceInputMode) => {
    if (modeRef.current === next) return;
    modeRef.current = next;
    setModeState(next);
    optionsRef.current.onModeChange?.(next);
  }, []);

  const setMode = useCallback(
    (next: VoiceInputMode) => {
      if (next === modeRef.current) return;
      startRequestRef.current += 1;
      startLockRef.current = null;
      if (modeRef.current === "dictation") dictation.cancel();
      else directAudio.cancel();
      activateMode(next);
    },
    [activateMode, dictation, directAudio]
  );

  const startDictation = useCallback(async () => {
    if (startLockRef.current) return;
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    startLockRef.current = { requestId, mode: "dictation" };
    directAudio.cancel();
    activateMode("dictation");
    try {
      await dictation.startDictation();
    } finally {
      if (startLockRef.current?.requestId === requestId) startLockRef.current = null;
    }
  }, [activateMode, dictation, directAudio]);

  const startRecording = useCallback(async () => {
    if (startLockRef.current) return;
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    startLockRef.current = { requestId, mode: "direct-audio" };
    dictation.cancel();
    activateMode("direct-audio");
    try {
      await directAudio.startRecording();
    } finally {
      if (startLockRef.current?.requestId === requestId) startLockRef.current = null;
    }
  }, [activateMode, dictation, directAudio]);

  const coordinatedDictation = useMemo(
    () => ({ ...dictation, startDictation }),
    [dictation, startDictation]
  );
  const coordinatedDirectAudio = useMemo(
    () => ({ ...directAudio, startRecording }),
    [directAudio, startRecording]
  );

  return {
    mode,
    setMode,
    dictation: coordinatedDictation,
    directAudio: coordinatedDirectAudio
  };
}
