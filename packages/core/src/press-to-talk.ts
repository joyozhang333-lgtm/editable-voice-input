import {
  BrowserVoiceCapture,
  type VoiceCaptureController,
  type VoiceCaptureOptions,
  type VoiceCaptureSession
} from "./capture";
import { createStableClientTurnId } from "./outbox";
import { mergeTranscriptDraft, transcriptionText } from "./draft";
import { VoiceInputError, type CapturedAudio, type TranscriptionResult } from "./types";

export type PressToTalkIntent = "send" | "dictate";
export type PressToTalkPhase =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "stopping"
  | "transcribing"
  | "committing"
  | "error";

export interface PressToTalkCommit {
  readonly audio: CapturedAudio;
  readonly intent: PressToTalkIntent;
  readonly sessionKey: string;
  readonly recordingId: string;
  readonly source: "pointer" | "activation";
  readonly signal: AbortSignal;
}

export interface PressToTalkSnapshot {
  readonly phase: PressToTalkPhase;
  readonly mode: PressToTalkIntent;
  readonly text: string;
  readonly transcriptSuggestion: string | null;
  readonly cancelPending: boolean;
  readonly sessionKey: string;
  readonly recordingId: string | null;
  readonly elapsedMs: number;
  readonly error: VoiceInputError | null;
  /** A completed dictate take can be retried explicitly without recording again. */
  readonly canRetryTranscription: boolean;
}

export interface PressToTalkOptions {
  sessionKey: string;
  /** Return text for dictate only. A successful callback is not a server receipt. */
  onCommit(input: PressToTalkCommit):
    void | string | TranscriptionResult | Promise<void | string | TranscriptionResult>;
  defaultText?: string;
  defaultMode?: PressToTalkIntent;
  cancelDistancePx?: number;
  capture?: VoiceCaptureController;
  captureOptions?: VoiceCaptureOptions;
}

export interface PressToTalkPointer {
  pointerId: number;
  clientY: number;
  button?: number;
  isPrimary?: boolean;
}

interface Operation {
  sessionKey: string;
  recordingId: string;
  intent: PressToTalkIntent;
  source: PressToTalkCommit["source"];
  abort: AbortController;
  draft: string;
  revision: number;
  stopRequested: boolean;
}

interface RetryableTranscription {
  audio: CapturedAudio;
  sessionKey: string;
  recordingId: string;
  source: PressToTalkCommit["source"];
}

/** No networking, persistence, Web Speech, or implicit transcript submission. */
export class PressToTalkController {
  private readonly capture: VoiceCaptureController;
  private readonly options: PressToTalkOptions;
  private readonly cancelDistancePx: number;
  private snapshot: PressToTalkSnapshot;
  private readonly listeners = new Set<() => void>();
  private operation: Operation | null = null;
  private retryableTranscription: RetryableTranscription | null = null;
  private session: VoiceCaptureSession | null = null;
  private pointer: { id: number; originY: number } | null = null;
  private revision = 0;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private detachLifecycle: (() => void) | null = null;

  constructor(options: PressToTalkOptions) {
    const distance = options.cancelDistancePx ?? 64;
    if (!Number.isFinite(distance) || distance <= 0) {
      throw new RangeError("cancelDistancePx must be a positive finite number.");
    }
    this.options = { ...options };
    this.cancelDistancePx = distance;
    this.capture = options.capture ?? new BrowserVoiceCapture(options.captureOptions);
    this.snapshot = Object.freeze({
      phase: "idle",
      mode: options.defaultMode ?? "send",
      text: options.defaultText ?? "",
      transcriptSuggestion: null,
      cancelPending: false,
      sessionKey: options.sessionKey,
      recordingId: null,
      elapsedMs: 0,
      error: null,
      canRetryTranscription: false
    });
  }

  readonly getSnapshot = (): PressToTalkSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly setText = (text: string): void => {
    if (this.disposed) return;
    this.revision += 1;
    this.update({ text });
  };

  readonly setSession = (sessionKey: string, text = ""): void => {
    if (this.disposed) return;
    this.invalidate();
    this.revision += 1;
    this.update({ ...this.idleState(), sessionKey, text });
  };

  readonly setMode = (mode: PressToTalkIntent): void => {
    if (this.disposed || mode === this.snapshot.mode) return;
    this.invalidate();
    this.update({ ...this.idleState(), mode });
  };

  readonly start = (options: { intent?: PressToTalkIntent } = {}): Promise<void> =>
    this.begin(options.intent ?? this.snapshot.mode, "activation");

  readonly pointerDown = (event: PressToTalkPointer): boolean => {
    if (
      event.isPrimary === false || (event.button !== undefined && event.button !== 0) ||
      !Number.isFinite(event.clientY) || !Number.isFinite(event.pointerId) || !this.canStart()
    ) return false;
    void this.begin(this.snapshot.mode, "pointer", { id: event.pointerId, originY: event.clientY });
    return true;
  };

  readonly pointerMove = (event: PressToTalkPointer): void => {
    if (this.pointer?.id !== event.pointerId || !Number.isFinite(event.clientY)) return;
    const cancelPending = this.pointer.originY - event.clientY >= this.cancelDistancePx;
    if (cancelPending !== this.snapshot.cancelPending) this.update({ cancelPending });
  };

  readonly pointerUp = (event: PressToTalkPointer): void => {
    if (this.pointer?.id !== event.pointerId) return;
    if (!Number.isFinite(event.clientY)) { this.cancel(); return; }
    this.pointerMove(event);
    this.stop();
  };

  readonly pointerCancel = (pointerId: number): void => {
    if (this.pointer?.id === pointerId) this.cancel();
  };

  /** Explicit stop-to-send for send recordings; dictate only produces an editable draft. */
  readonly stop = (): void => {
    if (this.snapshot.phase === "requesting-permission" || this.snapshot.cancelPending) {
      this.cancel();
      return;
    }
    const operation = this.operation;
    const session = this.session;
    if (!operation || !session || this.snapshot.phase !== "recording") return;
    operation.stopRequested = true;
    this.pointer = null;
    this.stopTimer();
    this.update({ phase: "stopping", cancelPending: false });
    if (!this.isCurrent(operation)) return;
    try {
      void session.stop().catch((error: unknown) => this.fail(operation, error));
    } catch (error) {
      this.fail(operation, error);
    }
  };

  readonly stopToDictate = (): void => {
    if (this.disposed) return;
    if (this.snapshot.phase === "recording" && this.operation) {
      const operation = this.operation;
      operation.intent = "dictate";
      this.update({ mode: "dictate" });
      if (this.isCurrent(operation)) this.stop();
    } else {
      this.cancel();
      this.update({ mode: "dictate" });
    }
  };

  readonly cancel = (): void => {
    if (this.disposed) return;
    this.invalidate();
    this.update(this.idleState());
  };

  /** Retry only an already captured dictate take. Never retries or sends a voice message. */
  readonly retryTranscription = async (): Promise<void> => {
    const retry = this.retryableTranscription;
    if (
      this.disposed || !retry || this.snapshot.phase !== "error" ||
      retry.sessionKey !== this.snapshot.sessionKey
    ) return;
    this.invalidate();
    const operation: Operation = {
      intent: "dictate", source: retry.source, sessionKey: retry.sessionKey,
      recordingId: retry.recordingId, abort: new AbortController(),
      draft: this.snapshot.text, revision: this.revision, stopRequested: true
    };
    this.operation = operation;
    this.watchLifecycle();
    if (!this.isCurrent(operation)) return;
    this.update({
      phase: "transcribing", mode: "dictate", error: null,
      recordingId: retry.recordingId, elapsedMs: retry.audio.durationMs,
      canRetryTranscription: false
    });
    if (!this.isCurrent(operation)) return;
    await this.commitAudio(operation, retry.audio);
  };

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.listeners.clear();
    this.capture.dispose();
  };

  private canStart(): boolean {
    return !this.disposed && ["idle", "error", "transcribing"].includes(this.snapshot.phase);
  }

  private async begin(
    intent: PressToTalkIntent,
    source: PressToTalkCommit["source"],
    pointer: typeof this.pointer = null
  ): Promise<void> {
    if (!this.canStart()) return;
    this.invalidate();
    let recordingId: string;
    try { recordingId = createStableClientTurnId(); }
    catch (error) {
      this.update({ ...this.idleState(), phase: "error", error: error as VoiceInputError });
      return;
    }
    const operation: Operation = {
      intent, source, sessionKey: this.snapshot.sessionKey,
      recordingId, abort: new AbortController(),
      draft: this.snapshot.text, revision: this.revision, stopRequested: false
    };
    this.operation = operation;
    this.pointer = pointer;
    this.update({
      ...this.idleState(), phase: "requesting-permission", mode: intent,
      recordingId: operation.recordingId
    });
    if (!this.isCurrent(operation)) return;
    this.watchLifecycle();
    if (!this.isCurrent(operation)) return;
    try {
      const session = await this.capture.start();
      // Consume even a stale result before cancelling custom capture implementations.
      void session.result.then(
        (audio) => this.captured(operation, audio),
        (error: unknown) => this.fail(operation, error)
      );
      if (!this.isCurrent(operation)) { session.cancel(); return; }
      this.session = session;
      const startedAt = Date.now();
      this.timer = setInterval(() => {
        this.update({ elapsedMs: Math.max(0, Date.now() - startedAt) });
      }, 250);
      this.update({ phase: "recording" });
    } catch (error) {
      this.fail(operation, error);
    }
  }

  private async captured(operation: Operation, audio: CapturedAudio): Promise<void> {
    if (!this.isCurrent(operation)) return;
    this.stopTimer();
    this.session = null;
    if (
      !operation.stopRequested ||
      (audio.terminationReason !== undefined && audio.terminationReason !== "user-stop")
    ) { this.cancel(); return; }
    if (!audio.blob.size || audio.size !== audio.blob.size) {
      this.fail(operation, new VoiceInputError("recording-empty", "Recording has no valid audio."));
      return;
    }
    this.update({
      phase: operation.intent === "send" ? "committing" : "transcribing",
      elapsedMs: audio.durationMs
    });
    if (!this.isCurrent(operation)) return;
    await this.commitAudio(operation, audio);
  }

  private async commitAudio(operation: Operation, audio: CapturedAudio): Promise<void> {
    try {
      const result = await this.options.onCommit({
        audio, intent: operation.intent, sessionKey: operation.sessionKey,
        recordingId: operation.recordingId, source: operation.source,
        signal: operation.abort.signal
      });
      if (!this.isCurrent(operation)) return;
      let patch: Partial<PressToTalkSnapshot> = { phase: "idle" };
      if (operation.intent === "dictate" && result !== undefined) {
        const text = transcriptionText(result);
        if (typeof text !== "string") throw new Error("Transcription must return text.");
        if (operation.revision === this.revision) {
          patch = { ...patch, text: mergeTranscriptDraft(operation.draft, text) };
        } else {
          patch = { ...patch, transcriptSuggestion: text };
        }
      }
      this.operation = null;
      this.detachLifecycle?.();
      this.detachLifecycle = null;
      this.update(patch);
    } catch (error) {
      this.fail(operation, error,
        operation.intent === "dictate" ? "transcription-failed" : "submission-failed",
        operation.intent === "dictate" ? audio : undefined);
    }
  }

  private fail(
    operation: Operation,
    error: unknown,
    code: "recording-failed" | "transcription-failed" | "submission-failed" = "recording-failed",
    retryAudio?: CapturedAudio
  ): void {
    if (!this.isCurrent(operation)) return;
    const failure = error instanceof VoiceInputError
      ? error : new VoiceInputError(code, "Voice input could not complete.", { cause: error });
    this.invalidate();
    const canRetry = Boolean(retryAudio && failure.code !== "capture-cancelled");
    if (canRetry && retryAudio) {
      this.retryableTranscription = {
        audio: retryAudio, sessionKey: operation.sessionKey,
        recordingId: operation.recordingId, source: operation.source
      };
    }
    this.update({
      ...this.idleState(),
      ...(failure.code === "capture-cancelled" ? {} : {
        phase: "error", error: failure,
        canRetryTranscription: canRetry
      })
    });
    if (
      canRetry && !this.disposed && this.retryableTranscription?.recordingId === operation.recordingId &&
      this.snapshot.canRetryTranscription
    ) this.watchLifecycle();
  }

  private isCurrent(operation: Operation): boolean {
    return !this.disposed && this.operation === operation && !operation.abort.signal.aborted;
  }

  private watchLifecycle(): void {
    const target = this.options.captureOptions?.pageLifecycleTarget ?? globalThis.window;
    const document = this.options.captureOptions?.visibilityDocument ?? globalThis.document;
    const hidden = () => { if (document?.visibilityState === "hidden") this.cancel(); };
    target?.addEventListener("pagehide", this.cancel);
    document?.addEventListener("visibilitychange", hidden);
    this.detachLifecycle = () => {
      target?.removeEventListener("pagehide", this.cancel);
      document?.removeEventListener("visibilitychange", hidden);
    };
    hidden();
  }

  private invalidate(): void {
    const operation = this.operation;
    this.operation = null;
    this.retryableTranscription = null;
    this.pointer = null;
    operation?.abort.abort();
    this.stopTimer();
    this.detachLifecycle?.();
    this.detachLifecycle = null;
    this.session?.cancel();
    this.session = null;
    this.capture.cancel();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private idleState(): Partial<PressToTalkSnapshot> {
    return {
      phase: "idle", error: null, recordingId: null, elapsedMs: 0,
      cancelPending: false, transcriptSuggestion: null, canRetryTranscription: false
    };
  }

  private update(patch: Partial<PressToTalkSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Host rendering must not interrupt capture cleanup. */ }
    }
  }
}
