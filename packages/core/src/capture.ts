import { chooseRecordingMimeType } from "./mime";
import {
  VoiceInputError,
  type CapturedAudio,
  type CaptureTerminationReason
} from "./types";

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
  /** Event target used for `pagehide`; injectable for tests and non-window hosts. */
  pageLifecycleTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Document-like visibility source; recording is safely stopped when it becomes hidden. */
  visibilityDocument?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  stopOnPageHide?: boolean;
  stopOnHidden?: boolean;
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

interface BrowserVoiceCaptureSessionOptions {
  maxDurationMs: number;
  maxBytes: number;
  timesliceMs: number;
  now: () => number;
  pageLifecycleTarget?: VoiceCaptureOptions["pageLifecycleTarget"];
  visibilityDocument?: VoiceCaptureOptions["visibilityDocument"];
  stopOnPageHide: boolean;
  stopOnHidden: boolean;
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
  private readonly pageLifecycleTarget?: VoiceCaptureOptions["pageLifecycleTarget"];
  private readonly visibilityDocument?: VoiceCaptureOptions["visibilityDocument"];
  private readonly tracks: MediaStreamTrack[];
  private readonly completion = deferred<CapturedAudio>();
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private terminalError: VoiceInputError | null = null;
  private stopRequested = false;
  private settled = false;
  private terminationReason: CaptureTerminationReason = "user-stop";

  constructor(
    recorder: MediaRecorder,
    stream: MediaStream,
    options: BrowserVoiceCaptureSessionOptions
  ) {
    this.recorder = recorder;
    this.stream = stream;
    this.now = options.now;
    this.maxBytes = options.maxBytes;
    this.startedAt = this.now();
    this.pageLifecycleTarget = options.pageLifecycleTarget;
    this.visibilityDocument = options.visibilityDocument;
    this.tracks = stream.getTracks();

    recorder.addEventListener("dataavailable", this.handleData);
    recorder.addEventListener("error", this.handleError);
    recorder.addEventListener("stop", this.handleStop, { once: true });
    for (const track of this.tracks) {
      track.addEventListener?.("ended", this.handleTrackEnded);
    }
    if (options.stopOnPageHide) {
      this.pageLifecycleTarget?.addEventListener("pagehide", this.handlePageHide);
    }
    if (options.stopOnHidden) {
      this.visibilityDocument?.addEventListener("visibilitychange", this.handleVisibilityChange);
    }

    try {
      recorder.start(options.timesliceMs);
      this.timer = setTimeout(() => {
        this.requestStop("max-duration");
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
    return !this.settled;
  }

  stop(): Promise<CapturedAudio> {
    this.requestStop("user-stop");
    return this.result;
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.requestStop("user-stop");
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
      this.requestStop("user-stop");
      return;
    }
    this.chunks.push(event.data);
  };

  private readonly handleError = (event: Event): void => {
    const mediaEvent = event as Event & { error?: DOMException };
    this.terminalError = new VoiceInputError("recording-failed", "Voice recording failed.", {
      cause: mediaEvent.error ?? event
    });
    this.requestStop("user-stop");
  };

  private readonly handleTrackEnded = (): void => {
    this.requestStop("track-ended");
  };

  private readonly handlePageHide = (): void => {
    this.requestStop("page-hidden");
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.visibilityDocument?.visibilityState === "hidden") {
      this.requestStop("page-hidden");
    }
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
    this.completion.resolve({
      blob,
      mimeType,
      durationMs,
      size: blob.size,
      terminationReason: this.terminationReason
    });
  };

  private requestStop(reason: CaptureTerminationReason): void {
    if (this.settled || this.stopRequested) return;
    this.stopRequested = true;
    this.terminationReason = reason;
    if (this.recorder.state === "inactive") {
      // MediaRecorder changes to inactive before its final dataavailable and
      // stop events. The stop event is the only safe point to assemble audio.
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
    for (const track of this.tracks) {
      track.removeEventListener?.("ended", this.handleTrackEnded);
    }
    this.pageLifecycleTarget?.removeEventListener("pagehide", this.handlePageHide);
    this.visibilityDocument?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
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

    const pageLifecycleTarget = this.options.pageLifecycleTarget ??
      (typeof globalThis.window !== "undefined" ? globalThis.window : undefined);
    const visibilityDocument = this.options.visibilityDocument ??
      (typeof globalThis.document !== "undefined" ? globalThis.document : undefined);
    const stopOnPageHide = this.options.stopOnPageHide ?? true;
    const stopOnHidden = this.options.stopOnHidden ?? true;
    let lifecycleCancelled = false;
    const cancelPendingStart = (): void => {
      if (operationId !== this.operationId) return;
      lifecycleCancelled = true;
      this.operationId += 1;
      this.starting = false;
    };
    const handlePendingVisibilityChange = (): void => {
      if (visibilityDocument?.visibilityState === "hidden") cancelPendingStart();
    };
    if (stopOnPageHide) {
      pageLifecycleTarget?.addEventListener("pagehide", cancelPendingStart);
    }
    if (stopOnHidden) {
      visibilityDocument?.addEventListener(
        "visibilitychange",
        handlePendingVisibilityChange
      );
      handlePendingVisibilityChange();
    }

    let stream: MediaStream;
    try {
      if (lifecycleCancelled) {
        throw new VoiceInputError(
          "capture-cancelled",
          "Voice recording was cancelled while the page was inactive."
        );
      }
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      });
    } catch (error) {
      if (lifecycleCancelled || operationId !== this.operationId) {
        throw new VoiceInputError("capture-cancelled", "Voice recording was cancelled.", {
          cause: error
        });
      }
      throw mapCaptureFailure(error);
    } finally {
      pageLifecycleTarget?.removeEventListener("pagehide", cancelPendingStart);
      visibilityDocument?.removeEventListener(
        "visibilitychange",
        handlePendingVisibilityChange
      );
      if (operationId === this.operationId) this.starting = false;
    }

    if (
      lifecycleCancelled ||
      operationId !== this.operationId ||
      (stopOnHidden && visibilityDocument?.visibilityState === "hidden")
    ) {
      stopTracks(stream);
      throw new VoiceInputError(
        "capture-cancelled",
        "Voice recording was cancelled while the page was inactive."
      );
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
        now: this.options.now ?? Date.now,
        ...(pageLifecycleTarget ? { pageLifecycleTarget } : {}),
        ...(visibilityDocument ? { visibilityDocument } : {}),
        stopOnPageHide,
        stopOnHidden
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
