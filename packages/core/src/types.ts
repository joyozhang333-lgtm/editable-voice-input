export const VOICE_INPUT_STATES = [
  "idle",
  "requesting-permission",
  "recording",
  "transcribing",
  "submitting",
  "review",
  "error"
] as const;

export type VoiceInputState = (typeof VOICE_INPUT_STATES)[number];

export type VoiceInputErrorCode =
  | "unsupported-browser"
  | "permission-denied"
  | "device-unavailable"
  | "recording-failed"
  | "recording-empty"
  | "recording-too-long"
  | "recording-too-large"
  | "capture-cancelled"
  | "transcription-failed"
  | "submission-failed";

export class VoiceInputError extends Error {
  readonly code: VoiceInputErrorCode;
  readonly cause?: unknown;

  constructor(code: VoiceInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "VoiceInputError";
    this.code = code;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  size: number;
}

export interface TranscriptionInput extends CapturedAudio {
  language?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export type Transcriber = (
  input: TranscriptionInput
) => Promise<string | TranscriptionResult>;

export interface VoiceSubmission {
  text: string;
  audio: CapturedAudio | null;
}
