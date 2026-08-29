import { mergeTranscriptDraft, transcriptionText, type MergeTranscriptOptions } from "./draft";
import {
  VoiceInputError,
  type CapturedAudio,
  type Transcriber,
  type TranscriptionResult
} from "./types";

/** A provider result must contain only the newly-finalized segment when `isFinal` is true. */
export interface DictationResult {
  transcript: string;
  isFinal: boolean;
  confidence?: number;
}

export interface DictationProviderStartInput {
  language?: string;
  signal?: AbortSignal;
  onResult(result: DictationResult): void;
}

export interface DictationProviderSession {
  /** Resolves when recognition ends and rejects when the provider fails. */
  readonly result: Promise<void>;
  readonly active: boolean;
  stop(): Promise<void>;
  cancel(): void;
}

export interface DictationProvider {
  start(input: DictationProviderStartInput): Promise<DictationProviderSession>;
}

/**
 * Interim speech is kept separate from `value`, so a changing hypothesis never
 * overwrites text that the user can edit.
 */
export interface EditableDictationDraft {
  baseValue: string;
  value: string;
  automaticValue: string;
  interimText: string;
  committedText: string;
  userEdited: boolean;
  authoritativeSuggestion: string | null;
}

export interface DictationDraftOptions {
  merge?: MergeTranscriptOptions;
}

export type AuthoritativeDictationResolution = "applied" | "review-required";

export interface AuthoritativeDictationOutcome {
  draft: EditableDictationDraft;
  resolution: AuthoritativeDictationResolution;
}

export interface AuthoritativeDictationFallbackInput extends DictationDraftOptions {
  draft: EditableDictationDraft;
  audio: CapturedAudio;
  transcribe: Transcriber;
  language?: string;
  signal?: AbortSignal;
}

const DEFAULT_DICTATION_SEPARATOR = " ";

function mergeOptions(options?: MergeTranscriptOptions): MergeTranscriptOptions {
  return {
    ...options,
    separator: options?.separator ?? DEFAULT_DICTATION_SEPARATOR
  };
}

function appendCommitted(existing: string, segment: string): string {
  return mergeTranscriptDraft(existing, segment, {
    strategy: "append",
    separator: DEFAULT_DICTATION_SEPARATOR
  });
}

export function createEditableDictationDraft(value = ""): EditableDictationDraft {
  return {
    baseValue: value,
    value,
    automaticValue: value,
    interimText: "",
    committedText: "",
    userEdited: false,
    authoritativeSuggestion: null
  };
}

export function applyDictationResult(
  draft: EditableDictationDraft,
  result: DictationResult,
  options: DictationDraftOptions = {}
): EditableDictationDraft {
  const transcript = result.transcript.trim();
  if (!result.isFinal) {
    return { ...draft, interimText: transcript };
  }
  if (!transcript) return { ...draft, interimText: "" };

  const committedText = appendCommitted(draft.committedText, transcript);
  const automaticValue = mergeTranscriptDraft(
    draft.baseValue,
    committedText,
    mergeOptions(options.merge)
  );
  const value = draft.userEdited
    ? mergeTranscriptDraft(draft.value, transcript, {
        strategy: "append",
        separator: options.merge?.separator ?? DEFAULT_DICTATION_SEPARATOR
      })
    : automaticValue;

  return {
    ...draft,
    value,
    automaticValue,
    interimText: "",
    committedText,
    authoritativeSuggestion: null
  };
}

export function applyDictationEdit(
  draft: EditableDictationDraft,
  value: string
): EditableDictationDraft {
  return {
    ...draft,
    value,
    userEdited: value !== draft.automaticValue
  };
}

/**
 * Batch transcription replaces streaming text only while the draft is still
 * untouched. When the user has edited, it is returned as a review suggestion.
 */
export function reconcileAuthoritativeDictation(
  draft: EditableDictationDraft,
  transcript: string,
  options: DictationDraftOptions = {}
): AuthoritativeDictationOutcome {
  const authoritativeText = transcript.trim();
  if (!authoritativeText) {
    throw new VoiceInputError(
      "transcription-failed",
      "The transcription service returned an empty transcript."
    );
  }

  if (!draft.userEdited && draft.value === draft.automaticValue) {
    const value = mergeTranscriptDraft(
      draft.baseValue,
      authoritativeText,
      mergeOptions(options.merge)
    );
    return {
      resolution: "applied",
      draft: {
        ...draft,
        value,
        automaticValue: value,
        interimText: "",
        committedText: authoritativeText,
        authoritativeSuggestion: null
      }
    };
  }

  return {
    resolution: "review-required",
    draft: {
      ...draft,
      interimText: "",
      authoritativeSuggestion: authoritativeText
    }
  };
}

export async function runAuthoritativeDictationFallback(
  input: AuthoritativeDictationFallbackInput
): Promise<AuthoritativeDictationOutcome> {
  const result: string | TranscriptionResult = await input.transcribe({
    ...input.audio,
    ...(input.language ? { language: input.language } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  return reconcileAuthoritativeDictation(input.draft, transcriptionText(result), {
    ...(input.merge ? { merge: input.merge } : {})
  });
}
