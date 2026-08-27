export const PREFERRED_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg"
] as const;

export interface MediaRecorderSupport {
  isTypeSupported(type: string): boolean;
}

export function chooseRecordingMimeType(
  support: MediaRecorderSupport | undefined = globalThis.MediaRecorder
): string | undefined {
  if (!support || typeof support.isTypeSupported !== "function") return undefined;
  return PREFERRED_RECORDING_MIME_TYPES.find((type) => support.isTypeSupported(type));
}

export function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function extensionForMimeType(value: string): string {
  switch (baseMimeType(value)) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    default:
      return "audio";
  }
}
