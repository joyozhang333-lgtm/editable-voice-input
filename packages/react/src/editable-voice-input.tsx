import { useId, type TextareaHTMLAttributes } from "react";
import { useVoiceInput, type UseVoiceInputOptions } from "./use-voice-input";

export interface VoiceInputLabels {
  draft: string;
  placeholder: string;
  record: string;
  stop: string;
  cancel: string;
  removeRecording: string;
  submit: string;
  requesting: string;
  recording: string;
  transcribing: string;
  submitting: string;
  review: string;
  error: string;
  playback: string;
}

export const DEFAULT_VOICE_INPUT_LABELS: VoiceInputLabels = {
  draft: "Message",
  placeholder: "Type or record a message",
  record: "Record",
  stop: "Stop",
  cancel: "Cancel",
  removeRecording: "Remove recording",
  submit: "Submit",
  requesting: "Requesting microphone permission…",
  recording: "Recording",
  transcribing: "Transcribing…",
  submitting: "Submitting…",
  review: "Review and edit before submitting",
  error: "Voice input could not be completed",
  playback: "Recorded audio preview"
};

export interface EditableVoiceInputProps extends UseVoiceInputOptions {
  labels?: Partial<VoiceInputLabels>;
  className?: string;
  disabled?: boolean;
  hideSubmit?: boolean;
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "defaultValue" | "onChange" | "disabled"
  >;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function EditableVoiceInput({
  labels: labelOverrides,
  className,
  disabled = false,
  hideSubmit = false,
  textareaProps,
  ...options
}: EditableVoiceInputProps) {
  const voice = useVoiceInput(options);
  const generatedTextareaId = useId();
  const textareaId = textareaProps?.id ?? generatedTextareaId;
  const labels = { ...DEFAULT_VOICE_INPUT_LABELS, ...labelOverrides };
  const busy =
    voice.state === "requesting-permission" ||
    voice.state === "transcribing" ||
    voice.state === "submitting";
  const recording = voice.state === "recording";
  const rootClassName = ["evi-root", className].filter(Boolean).join(" ");

  let statusText = "";
  if (voice.state === "requesting-permission") statusText = labels.requesting;
  if (recording) statusText = labels.recording;
  if (voice.state === "transcribing") statusText = labels.transcribing;
  if (voice.state === "submitting") statusText = labels.submitting;
  if (voice.state === "review") statusText = labels.review;
  if (voice.state === "error") statusText = voice.error?.message || labels.error;

  return (
    <section className={rootClassName} data-state={voice.state} aria-label={labels.draft}>
      <label className="evi-sr-only" htmlFor={textareaId}>
        {labels.draft}
      </label>
      <textarea
        {...textareaProps}
        id={textareaId}
        className={["evi-draft", textareaProps?.className].filter(Boolean).join(" ")}
        value={voice.value}
        placeholder={textareaProps?.placeholder ?? labels.placeholder}
        disabled={disabled}
        onChange={(event) => voice.setValue(event.currentTarget.value)}
      />

      {voice.audioUrl ? (
        <div className="evi-preview">
          <audio
            className="evi-audio"
            controls
            preload="metadata"
            src={voice.audioUrl}
            aria-label={labels.playback}
          >
            {labels.playback}
          </audio>
          <button
            className="evi-link-button"
            type="button"
            onClick={voice.clearRecording}
            disabled={disabled || recording || busy}
          >
            {labels.removeRecording}
          </button>
        </div>
      ) : null}

      <div className="evi-footer">
        <div className="evi-voice-actions">
          <button
            className={recording ? "evi-record-button is-recording" : "evi-record-button"}
            type="button"
            onClick={recording ? voice.stopRecording : voice.startRecording}
            disabled={disabled || busy}
            aria-pressed={recording}
          >
            <span className="evi-record-dot" aria-hidden="true" />
            {recording ? labels.stop : labels.record}
          </button>
          {recording ? (
            <span className="evi-duration" aria-hidden="true">
              {formatDuration(voice.elapsedMs)}
            </span>
          ) : null}
          {recording ? (
            <button className="evi-link-button" type="button" onClick={voice.cancel}>
              {labels.cancel}
            </button>
          ) : null}
        </div>

        {!hideSubmit ? (
          <button
            className="evi-submit-button"
            type="button"
            onClick={() => void voice.submit()}
            disabled={disabled || busy || recording || !voice.value.trim()}
          >
            {labels.submit}
          </button>
        ) : null}
      </div>

      <p
        className={voice.state === "error" ? "evi-status is-error" : "evi-status"}
        aria-live="polite"
        role="status"
      >
        {statusText || "\u00a0"}
      </p>
    </section>
  );
}
