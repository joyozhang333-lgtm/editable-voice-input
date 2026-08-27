export type SupportedAudioMimeType =
  | "audio/webm"
  | "audio/ogg"
  | "audio/mp4"
  | "audio/wav"
  | "audio/mpeg"
  | "audio/aac"
  | "audio/flac";

export interface ProviderTranscriptionInput {
  audio: Uint8Array;
  mimeType: SupportedAudioMimeType;
  filename: string;
  language?: string;
  signal?: AbortSignal;
}

export interface ProviderTranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export interface TranscriptionProvider {
  transcribe(
    input: ProviderTranscriptionInput
  ): Promise<string | ProviderTranscriptionResult>;
}

export type TranscriptionServerErrorCode =
  | "method-not-allowed"
  | "origin-not-allowed"
  | "unauthorized"
  | "body-required"
  | "body-too-large"
  | "audio-too-long"
  | "invalid-audio-duration"
  | "unsupported-audio"
  | "mime-mismatch"
  | "transcription-failed"
  | "empty-transcript";

export class TranscriptionServerError extends Error {
  readonly code: TranscriptionServerErrorCode;
  readonly status: number;
  readonly cause?: unknown;

  constructor(
    code: TranscriptionServerErrorCode,
    message: string,
    status: number,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = "TranscriptionServerError";
    this.code = code;
    this.status = status;
    if (options && "cause" in options) this.cause = options.cause;
  }
}
