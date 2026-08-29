import type { VoiceCaptureSession } from "@editable-voice-input/core";

/** Injectable capture boundary shared by all React voice hooks. */
export interface VoiceCaptureController {
  start(): Promise<VoiceCaptureSession>;
  cancel(): void;
  dispose(): void;
}
