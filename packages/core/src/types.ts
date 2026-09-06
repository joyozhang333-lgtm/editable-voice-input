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

export type CaptureTerminationReason =
  | "user-stop"
  | "max-duration"
  | "track-ended"
  | "page-hidden";

export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  size: number;
  /** Browser capture reports why it stopped; custom capture adapters should do the same. */
  terminationReason?: CaptureTerminationReason;
}

export interface TranscriptionInput extends CapturedAudio {
  language?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  /** Canonical duration unit for every public package. */
  durationMs?: number;
  /** @deprecated Return `durationMs` instead. Accepted for 0.1 provider compatibility. */
  durationSeconds?: number;
}

export type Transcriber = (
  input: TranscriptionInput
) => Promise<string | TranscriptionResult>;

export interface VoiceSubmission {
  text: string;
  audio: CapturedAudio | null;
}
