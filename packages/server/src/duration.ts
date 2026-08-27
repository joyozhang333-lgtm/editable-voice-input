import { TranscriptionServerError, type SupportedAudioMimeType } from "./types";

export type AudioDurationInspector = (
  audio: Uint8Array,
  mimeType: SupportedAudioMimeType
) => number | Promise<number>;

export async function inspectAudioDurationMs(
  audio: Uint8Array,
  mimeType: SupportedAudioMimeType
): Promise<number> {
  try {
    const { parseBuffer } = await import("music-metadata");
    // ADTS AAC and other stream formats require a full frame scan to derive duration.
    const metadata = await parseBuffer(audio, { mimeType }, { duration: true });
    const durationSeconds = metadata.format.duration;
    if (
      typeof durationSeconds !== "number" ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new Error("Audio duration is missing.");
    }
    return durationSeconds * 1_000;
  } catch (error) {
    if (error instanceof TranscriptionServerError) throw error;
    throw new TranscriptionServerError(
      "invalid-audio-duration",
      "The audio duration could not be verified.",
      415,
      { cause: error }
    );
  }
}
