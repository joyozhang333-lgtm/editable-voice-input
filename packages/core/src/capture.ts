import { chooseRecordingMimeType } from "./mime";
import { VoiceInputError, type CapturedAudio } from "./types";

export const DEFAULT_MAX_DURATION_MS = 120_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface VoiceCaptureOptions {
  maxDurationMs?: number;
  maxBytes?: number;
  audioBitsPerSecond?: number;
  timesliceMs?: number;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorderConstructor?: typeof MediaRecorder;
  now?: () => number;
}

export interface VoiceCaptureSession {
  readonly result: Promise<CapturedAudio>;
  readonly active: boolean;
  stop(): Promise<CapturedAudio>;
  cancel(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Releasing the remaining tracks is more important than one broken track.
    }
  }
}

function mapCaptureFailure(error: unknown): VoiceInputError {
  if (error instanceof VoiceInputError) return error;
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceInputError("permission-denied", "Microphone permission was denied.", {
      cause: error
    });
  }
  if (name === "NotFoundError" || name === "NotReadableError" || name === "AbortError") {
    return new VoiceInputError("device-unavailable", "No usable microphone is available.", {
      cause: error
    });
  }
  return new VoiceInputError("recording-failed", "Voice recording could not start.", {
    cause: error
  });
}

class BrowserVoiceCaptureSession implements VoiceCaptureSession {
  private readonly recorder: MediaRecorder;
  private readonly stream: MediaStream;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly completion = deferred<CapturedAudio>();
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private terminalError: VoiceInputError | null = null;
  private settled = false;

  constructor(
    recorder: MediaRecorder,
    stream: MediaStream,
    options: Required<Pick<VoiceCaptureOptions, "maxDurationMs" | "maxBytes" | "timesliceMs">> & {
      now: () => number;
    }
  ) {
    this.recorder = recorder;
    this.stream = stream;
    this.now = options.now;
    this.maxBytes = options.maxBytes;
    this.startedAt = this.now();

    recorder.addEventListener("dataavailable", this.handleData);
    recorder.addEventListener("error", this.handleError);
    recorder.addEventListener("stop", this.handleStop, { once: true });

    try {
      recorder.start(options.timesliceMs);
      this.timer = setTimeout(() => {
        this.requestStop();
      }, options.maxDurationMs);
    } catch (error) {
      this.cleanup();
      throw mapCaptureFailure(error);
    }
  }

  get result(): Promise<CapturedAudio> {
    return this.completion.promise;
  }

  get active(): boolean {
    return !this.settled && this.recorder.state !== "inactive";
  }

  stop(): Promise<CapturedAudio> {
    this.requestStop();
    return this.result;
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.requestStop();
  }

  private readonly handleData = (event: BlobEvent): void => {
    if (!event.data.size || this.cancelled || this.terminalError) return;
    this.bytes += event.data.size;
    if (this.bytes > this.maxBytes) {
      this.terminalError = new VoiceInputError(
        "recording-too-large",
        `Recording exceeded ${this.maxBytes} bytes.`
      );
      this.chunks.length = 0;
      this.requestStop();
      return;
    }
    this.chunks.push(event.data);
  };

  private readonly handleError = (event: Event): void => {
    const mediaEvent = event as Event & { error?: DOMException };
    this.terminalError = new VoiceInputError("recording-failed", "Voice recording failed.", {
      cause: mediaEvent.error ?? event
    });
    this.requestStop();
  };

  private readonly handleStop = (): void => {
    if (this.settled) return;
    this.settled = true;
    const durationMs = Math.max(0, this.now() - this.startedAt);
    const mimeType = this.recorder.mimeType || this.chunks[0]?.type || "application/octet-stream";
    const error = this.terminalError;
    const cancelled = this.cancelled;
    const blob = new Blob(this.chunks, { type: mimeType });
    this.cleanup();

    if (cancelled) {
      this.completion.reject(
        new VoiceInputError("capture-cancelled", "Voice recording was cancelled.")
      );
      return;
    }
    if (error) {
      this.completion.reject(error);
      return;
    }
    if (!blob.size) {
      this.completion.reject(
        new VoiceInputError("recording-empty", "Voice recording did not contain audio.")
      );
      return;
    }
    this.completion.resolve({ blob, mimeType, durationMs, size: blob.size });
  };

  private requestStop(): void {
    if (this.settled) return;
    if (this.recorder.state === "inactive") {
      this.handleStop();
      return;
    }
    try {
      this.recorder.stop();
    } catch (error) {
      this.terminalError = mapCaptureFailure(error);
      this.handleStop();
    }
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.recorder.removeEventListener("dataavailable", this.handleData);
    this.recorder.removeEventListener("error", this.handleError);
    stopTracks(this.stream);
  }
}

export class BrowserVoiceCapture {
  private readonly options: VoiceCaptureOptions;
  private current: VoiceCaptureSession | null = null;
  private operationId = 0;
  private starting = false;

  constructor(options: VoiceCaptureOptions = {}) {
    this.options = options;
  }

  async start(): Promise<VoiceCaptureSession> {
    if (this.starting || this.current?.active) {
      throw new VoiceInputError("recording-failed", "A voice recording is already active.");
    }

    const mediaDevices = this.options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    const MediaRecorderConstructor =
      this.options.MediaRecorderConstructor ?? globalThis.MediaRecorder;
    if (!mediaDevices?.getUserMedia || !MediaRecorderConstructor) {
      throw new VoiceInputError(
        "unsupported-browser",
        "This browser does not support microphone recording."
      );
    }

    const operationId = ++this.operationId;
    this.starting = true;

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
    } catch (error) {
      if (operationId !== this.operationId) {
        throw new VoiceInputError("capture-cancelled", "Voice recording was cancelled.", {
          cause: error
        });
      }
      throw mapCaptureFailure(error);
    } finally {
      if (operationId === this.operationId) this.starting = false;
    }

    if (operationId !== this.operationId) {
      stopTracks(stream);
      throw new VoiceInputError("capture-cancelled", "Voice recording was cancelled.");
    }

    try {
      const mimeType = chooseRecordingMimeType(MediaRecorderConstructor);
      const recorderOptions: MediaRecorderOptions = {};
      if (mimeType) recorderOptions.mimeType = mimeType;
      if (this.options.audioBitsPerSecond) {
        recorderOptions.audioBitsPerSecond = this.options.audioBitsPerSecond;
      }
      const recorder = new MediaRecorderConstructor(stream, recorderOptions);
      const session = new BrowserVoiceCaptureSession(recorder, stream, {
        maxDurationMs: this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
        maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
        timesliceMs: this.options.timesliceMs ?? 1_000,
        now: this.options.now ?? Date.now
      });
      if (operationId !== this.operationId) {
        session.cancel();
        throw new VoiceInputError("capture-cancelled", "Voice recording was cancelled.");
      }
      this.current = session;
      void session.result.then(
        () => {
          if (this.current === session) this.current = null;
        },
        () => {
          if (this.current === session) this.current = null;
        }
      );
      return session;
    } catch (error) {
      stopTracks(stream);
      throw mapCaptureFailure(error);
    }
  }

  cancel(): void {
    this.operationId += 1;
    this.starting = false;
    this.current?.cancel();
    this.current = null;
  }

  dispose(): void {
    this.cancel();
  }
}

export function isVoiceCaptureSupported(): boolean {
  return (
    typeof globalThis.navigator !== "undefined" &&
    typeof globalThis.navigator.mediaDevices !== "undefined" &&
    typeof globalThis.MediaRecorder !== "undefined"
  );
}
