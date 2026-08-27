import {
  TranscriptionServerError,
  type SupportedAudioMimeType
} from "./types";

const MIME_ALIASES: Readonly<Record<string, SupportedAudioMimeType>> = {
  "audio/webm": "audio/webm",
  "video/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/aac": "audio/aac",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac"
};

export const SUPPORTED_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/mpeg",
  "audio/aac",
  "audio/flac"
] as const satisfies readonly SupportedAudioMimeType[];

export function normalizeDeclaredMime(value: string | null): SupportedAudioMimeType | null {
  if (!value) return null;
  const base = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_ALIASES[base] ?? null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function sniffAudioMime(bytes: Uint8Array): SupportedAudioMimeType | null {
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return "audio/wav";
  }
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "audio/mp4";
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg";
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe6) === 0xe2) {
    return "audio/mpeg";
  }
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xf6) === 0xf0) {
    return "audio/aac";
  }
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac";
  return null;
}

export function validateAudioMime(
  bytes: Uint8Array,
  declaredContentType: string | null,
  allowed: readonly SupportedAudioMimeType[] = SUPPORTED_AUDIO_MIME_TYPES
): SupportedAudioMimeType {
  const detected = sniffAudioMime(bytes);
  if (!detected || !allowed.includes(detected)) {
    throw new TranscriptionServerError(
      "unsupported-audio",
      "The request body is not a supported audio file.",
      415
    );
  }

  const declaredBase = declaredContentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const declarationMayBeGeneric =
    !declaredBase || declaredBase === "application/octet-stream" || declaredBase === "binary/octet-stream";
  const declared = normalizeDeclaredMime(declaredContentType);
  if (!declarationMayBeGeneric && !declared) {
    throw new TranscriptionServerError(
      "unsupported-audio",
      "The declared content type is not supported.",
      415
    );
  }
  if (declared && declared !== detected) {
    throw new TranscriptionServerError(
      "mime-mismatch",
      "The declared content type does not match the audio file signature.",
      415
    );
  }
  return detected;
}

export function extensionForAudioMime(mimeType: SupportedAudioMimeType): string {
  const extensions: Record<SupportedAudioMimeType, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "audio/flac": "flac"
  };
  return extensions[mimeType];
}
