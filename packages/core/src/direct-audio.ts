import { VoiceInputError, type CapturedAudio } from "./types";

export interface PlayableAudioMetadata {
  url: string;
  mimeType: string;
  durationMs: number;
  size: number;
}

export interface DirectAudioMessage {
  id: string;
  clientMessageId: string;
  kind: "audio";
  createdAt: string;
  audio: PlayableAudioMetadata;
  transcript?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface DirectAudioUploadInput {
  clientMessageId: string;
  audio: CapturedAudio;
  metadata?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface DirectAudioUploadTransport {
  upload(input: DirectAudioUploadInput): Promise<DirectAudioMessage>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VoiceInputError("submission-failed", `Audio message ${field} is invalid.`);
  }
  return value as UnknownRecord;
}

function requiredString(record: UnknownRecord, key: string, field = key): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new VoiceInputError("submission-failed", `Audio message ${field} is required.`);
  }
  return value;
}

function requiredFiniteNumber(record: UnknownRecord, key: string, field = key): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VoiceInputError("submission-failed", `Audio message ${field} is invalid.`);
  }
  return value;
}

function optionalMetadata(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const source = asRecord(value, "metadata");
  const metadata = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== "string") {
      throw new VoiceInputError(
        "submission-failed",
        "Audio message metadata values must be strings."
      );
    }
    metadata[key] = item;
  }
  return metadata;
}

export function validateDirectAudioMessage(
  message: unknown,
  expectedClientMessageId?: string
): DirectAudioMessage {
  const source = asRecord(message, "payload");
  const id = requiredString(source, "id");
  const clientMessageId = requiredString(source, "clientMessageId");
  const createdAt = requiredString(source, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new VoiceInputError("submission-failed", "Audio message createdAt is invalid.");
  }
  if (source.kind !== "audio") {
    throw new VoiceInputError("submission-failed", "Upload returned a non-audio message.");
  }
  const audioSource = asRecord(source.audio, "audio");
  const url = requiredString(audioSource, "url", "audio.url");
  const mimeType = requiredString(audioSource, "mimeType", "audio.mimeType");
  if (!/^audio\/[a-z0-9.+-]+(?:\s*;.*)?$/i.test(mimeType)) {
    throw new VoiceInputError("submission-failed", "Audio message MIME type is invalid.");
  }
  const durationMs = requiredFiniteNumber(audioSource, "durationMs", "audio.durationMs");
  if (durationMs < 0) {
    throw new VoiceInputError("submission-failed", "Audio message duration is invalid.");
  }
  const size = requiredFiniteNumber(audioSource, "size", "audio.size");
  if (!Number.isInteger(size) || size <= 0) {
    throw new VoiceInputError("submission-failed", "Audio message size is invalid.");
  }
  if (source.transcript !== undefined && typeof source.transcript !== "string") {
    throw new VoiceInputError("submission-failed", "Audio message transcript is invalid.");
  }
  const metadata = optionalMetadata(source.metadata);
  if (expectedClientMessageId && clientMessageId !== expectedClientMessageId) {
    throw new VoiceInputError(
      "submission-failed",
      "Upload returned a mismatched clientMessageId."
    );
  }
  return {
    id,
    clientMessageId,
    kind: "audio",
    createdAt,
    audio: { url, mimeType, durationMs, size },
    ...(typeof source.transcript === "string" ? { transcript: source.transcript } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export async function uploadDirectAudioMessage(
  transport: DirectAudioUploadTransport,
  input: DirectAudioUploadInput
): Promise<DirectAudioMessage> {
  if (!input.clientMessageId.trim()) {
    throw new VoiceInputError("submission-failed", "Audio message clientMessageId is required.");
  }
  const message = await transport.upload(input);
  return validateDirectAudioMessage(message, input.clientMessageId);
}
