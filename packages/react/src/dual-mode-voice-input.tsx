import { useId, useRef, type KeyboardEvent } from "react";
import {
  useDualModeVoiceInput,
  type UseDualModeVoiceInputOptions,
  type VoiceInputMode
} from "./use-dual-mode-voice-input";

export interface DualModeVoiceInputLabels {
  group: string;
  dictationTab: string;
  directAudioTab: string;
  draft: string;
  interim: string;
  start: string;
  stop: string;
  sendAudio: string;
  cancel: string;
  privacyFallback: string;
  requesting: string;
  recording: string;
  stopping: string;
  transcribing: string;
  uploading: string;
  ready: string;
  sent: string;
  callbackError: string;
  playback: string;
}

const DEFAULT_LABELS: DualModeVoiceInputLabels = {
  group: "Voice input mode",
  dictationTab: "Edit text",
  directAudioTab: "Send recording",
  draft: "Editable transcript",
  interim: "Listening",
  start: "Record",
  stop: "Stop",
  sendAudio: "Send recording",
  cancel: "Cancel",
  privacyFallback: "Live recognition is unavailable. Recording continues for batch transcription.",
  requesting: "Requesting microphone permission",
  recording: "Recording",
  stopping: "Finishing recording",
  transcribing: "Transcribing recording",
  uploading: "Sending recording",
  ready: "Recording ready for review",
  sent: "Recording sent",
  callbackError: "Recording was sent, but the host callback failed",
  playback: "Recorded audio preview"
};

export interface DualModeVoiceInputProps extends UseDualModeVoiceInputOptions {
  labels?: Partial<DualModeVoiceInputLabels>;
  className?: string;
}

export function DualModeVoiceInput({
  labels: overrides,
  className,
  ...options
}: DualModeVoiceInputProps) {
  const voice = useDualModeVoiceInput(options);
  const labels = { ...DEFAULT_LABELS, ...overrides };
  const generatedId = useId();
  const dictationTabRef = useRef<HTMLButtonElement>(null);
  const directTabRef = useRef<HTMLButtonElement>(null);
  const recordingDictation = voice.dictation.state === "listening";
  const recordingDirect = voice.directAudio.state === "recording";
  const dictationBusy = ["starting", "stopping", "transcribing"].includes(
    voice.dictation.state
  );
  const directBusy = ["requesting-permission", "stopping", "uploading"].includes(
    voice.directAudio.state
  );
  const dictationStatus = voice.dictation.error?.message ??
    (voice.dictation.liveError
      ? labels.privacyFallback
      : voice.dictation.state === "starting"
        ? labels.requesting
        : voice.dictation.state === "stopping"
          ? labels.stopping
          : voice.dictation.state === "transcribing"
            ? labels.transcribing
            : voice.dictation.interimText
              ? `${labels.interim}: ${voice.dictation.interimText}`
              : voice.dictation.state === "listening"
                ? labels.recording
              : voice.dictation.state === "review"
                ? labels.ready
                : "\u00a0");
  const directStatus = voice.directAudio.error?.message ??
    (voice.directAudio.callbackError
      ? labels.callbackError
      : voice.directAudio.state === "requesting-permission"
        ? labels.requesting
        : voice.directAudio.state === "stopping"
          ? labels.stopping
          : voice.directAudio.state === "uploading"
            ? labels.uploading
            : voice.directAudio.state === "recording"
              ? labels.recording
              : voice.directAudio.state === "ready"
              ? labels.ready
              : voice.directAudio.state === "sent"
                ? labels.sent
                : "\u00a0");
  const rootClassName = ["evi-root", "evi-dual", className].filter(Boolean).join(" ");

  const chooseMode = (mode: VoiceInputMode, focus = false) => {
    voice.setMode(mode);
    if (focus) {
      queueMicrotask(() =>
        (mode === "dictation" ? dictationTabRef.current : directTabRef.current)?.focus()
      );
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home" ||
      (event.key === "ArrowLeft" && voice.mode === "direct-audio") ||
      (event.key === "ArrowRight" && voice.mode === "direct-audio")
        ? "dictation"
        : "direct-audio";
    chooseMode(next, true);
  };

  return (
    <section className={rootClassName} aria-label={labels.group}>
      <div className="evi-mode-tabs" role="tablist" aria-label={labels.group}>
        <button
          ref={dictationTabRef}
          id={`${generatedId}-dictation-tab`}
          role="tab"
          type="button"
          aria-selected={voice.mode === "dictation"}
          aria-controls={`${generatedId}-dictation-panel`}
          tabIndex={voice.mode === "dictation" ? 0 : -1}
          onClick={() => chooseMode("dictation")}
          onKeyDown={handleTabKeyDown}
        >
          {labels.dictationTab}
        </button>
        <button
          ref={directTabRef}
          id={`${generatedId}-direct-tab`}
          role="tab"
          type="button"
          aria-selected={voice.mode === "direct-audio"}
          aria-controls={`${generatedId}-direct-panel`}
          tabIndex={voice.mode === "direct-audio" ? 0 : -1}
          onClick={() => chooseMode("direct-audio")}
          onKeyDown={handleTabKeyDown}
        >
          {labels.directAudioTab}
        </button>
      </div>

      {voice.mode === "dictation" ? (
        <div
          id={`${generatedId}-dictation-panel`}
          role="tabpanel"
          aria-labelledby={`${generatedId}-dictation-tab`}
          className="evi-mode-panel"
          aria-busy={dictationBusy}
        >
          <label className="evi-sr-only" htmlFor={`${generatedId}-draft`}>
            {labels.draft}
          </label>
          <textarea
            id={`${generatedId}-draft`}
            className="evi-draft"
            value={voice.dictation.value}
            onChange={(event) => voice.dictation.setValue(event.currentTarget.value)}
          />
          <p
            className={voice.dictation.error ? "evi-status is-error" : "evi-status"}
            aria-live="polite"
            role="status"
          >
            {dictationStatus}
          </p>
          <div className="evi-footer">
            <button
              className="evi-record-button"
              type="button"
              disabled={dictationBusy}
              aria-pressed={recordingDictation}
              onClick={
                recordingDictation
                  ? voice.dictation.stopDictation
                  : () => void voice.dictation.startDictation()
              }
            >
              {recordingDictation ? labels.stop : labels.start}
            </button>
            {recordingDictation || dictationBusy ? (
              <button className="evi-link-button" type="button" onClick={voice.dictation.cancel}>
                {labels.cancel}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          id={`${generatedId}-direct-panel`}
          role="tabpanel"
          aria-labelledby={`${generatedId}-direct-tab`}
          className="evi-mode-panel"
          aria-busy={directBusy}
        >
          {voice.directAudio.audioUrl ? (
            <audio
              controls
              preload="metadata"
              src={voice.directAudio.audioUrl}
              aria-label={labels.playback}
            />
          ) : null}
          <div className="evi-footer">
            <button
              className="evi-record-button"
              type="button"
              disabled={directBusy}
              aria-pressed={recordingDirect}
              onClick={
                recordingDirect
                  ? voice.directAudio.stopRecording
                  : () => void voice.directAudio.startRecording()
              }
            >
              {recordingDirect ? labels.stop : labels.start}
            </button>
            {recordingDirect || directBusy ? (
              <button
                className="evi-link-button"
                type="button"
                onClick={voice.directAudio.cancel}
              >
                {labels.cancel}
              </button>
            ) : null}
            {voice.directAudio.audio && !voice.directAudio.message ? (
              <button
                className="evi-submit-button"
                type="button"
                disabled={voice.directAudio.state === "uploading"}
                onClick={() => void voice.directAudio.send()}
              >
                {labels.sendAudio}
              </button>
            ) : null}
          </div>
          <p
            className={voice.directAudio.error ? "evi-status is-error" : "evi-status"}
            aria-live="polite"
            role="status"
          >
            {directStatus}
          </p>
        </div>
      )}
    </section>
  );
}
