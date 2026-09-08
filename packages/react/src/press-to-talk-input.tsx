import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { AudioLines, Keyboard, Mic, Send, Square, X } from "lucide-react";
import { bindPressToTalk, type PressToTalkController } from "@editable-voice-input/core";

export interface PressToTalkLabels {
  group: string;
  hold: string;
  release: string;
  cancelRelease: string;
  edit: string;
  voice: string;
  draft: string;
  dictate: string;
  stopDictation: string;
  cancel: string;
  submitText: string;
  requesting: string;
  stopping: string;
  transcribing: string;
  committing: string;
  suggestion: string;
  holdAccessible: string;
  releaseAccessible: string;
}

const defaults: PressToTalkLabels = {
  group: "Voice composer", hold: "Hold to talk, release to send", release: "Release to send",
  cancelRelease: "Release to cancel", edit: "Edit text", voice: "Voice message",
  draft: "Message", dictate: "Dictate text", stopDictation: "Stop dictation",
  cancel: "Cancel", submitText: "Send text", requesting: "Waiting for microphone permission",
  stopping: "Finishing recording", transcribing: "Transcribing", committing: "Processing voice message",
  suggestion: "Transcript", holdAccessible: "Hold to talk, release to send. Activate to start recording.",
  releaseAccessible: "Release to send. Activate to stop and send."
};

export interface PressToTalkInputProps {
  /** Own one controller per mounted composer; call setSession on identity/conversation changes. */
  controller: PressToTalkController;
  labels?: Partial<PressToTalkLabels>;
  className?: string;
  /** Text submission is a separate, explicit host action, never called by transcription. */
  onSubmitText?: (input: { text: string; sessionKey: string }) => void;
}

export function PressToTalkInput({ controller, labels: overrides, className, onSubmitText }: PressToTalkInputProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const holdRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const labels = { ...defaults, ...overrides };
  const recording = state.phase === "recording";
  const pending = state.phase === "requesting-permission";
  const busy = !["idle", "error", "recording", "requesting-permission"].includes(state.phase);
  const active = !["idle", "error"].includes(state.phase);
  useEffect(() => bindPressToTalk(holdRef.current!, controller), [controller]);
  useEffect(() => {
    if (state.mode === "dictate") draftRef.current?.focus();
  }, [state.mode]);

  const status = state.error?.message ??
    (pending ? labels.requesting : state.phase === "stopping" ? labels.stopping :
      state.phase === "transcribing" ? labels.transcribing :
      state.phase === "committing" ? labels.committing :
      recording ? `${Math.floor(state.elapsedMs / 1000)}s` : "");
  const holdText = state.cancelPending ? labels.cancelRelease : recording ? labels.release : labels.hold;

  return (
    <section className={["evi-root", "evi-ptt", className].filter(Boolean).join(" ")}
      aria-label={labels.group}
      onKeyDown={(event) => { if (event.key === "Escape") controller.cancel(); }}>
      <div className="evi-ptt-editor" hidden={state.mode !== "dictate"}>
        <textarea ref={draftRef} className="evi-draft" aria-label={labels.draft}
          value={state.text} onChange={(event) => controller.setText(event.currentTarget.value)} />
        {state.transcriptSuggestion !== null ? (
          <details className="evi-ptt-suggestion">
            <summary>{labels.suggestion}</summary><p>{state.transcriptSuggestion}</p>
          </details>
        ) : null}
      </div>
      <div className="evi-ptt-row">
        <button type="button" className="evi-ptt-icon" title={state.mode === "send" ? labels.edit : labels.voice}
          aria-label={state.mode === "send" ? labels.edit : labels.voice}
          onClick={() => {
            if (state.mode === "dictate") controller.setMode("send");
            else if (recording || pending) controller.stopToDictate();
            else controller.setMode("dictate");
          }}>
          {state.mode === "send" ? <Keyboard aria-hidden size={22} /> : <AudioLines aria-hidden size={22} />}
        </button>
        <button ref={holdRef} type="button" className="evi-ptt-hold" hidden={state.mode !== "send"}
          data-recording={recording} data-cancelling={state.cancelPending}
          aria-pressed={recording} aria-disabled={busy}
          aria-label={recording ? labels.releaseAccessible : labels.holdAccessible}
          aria-describedby={`${id}-status`}>
          {holdText}
        </button>
        {state.mode === "dictate" ? (
          <button type="button" className="evi-ptt-icon" disabled={busy && state.phase !== "transcribing"}
            title={recording || pending ? labels.stopDictation : labels.dictate}
            aria-label={recording || pending ? labels.stopDictation : labels.dictate}
            aria-pressed={recording}
            onClick={() => {
              if (recording || pending) controller.stop();
              else void controller.start({ intent: "dictate" });
            }}>
            {recording || pending ? <Square aria-hidden size={20} /> : <Mic aria-hidden size={22} />}
          </button>
        ) : null}
        <button type="button" className="evi-ptt-icon" title={labels.cancel} aria-label={labels.cancel}
          style={{ visibility: active ? "visible" : "hidden" }} disabled={!active} aria-hidden={!active}
          onClick={controller.cancel}><X aria-hidden size={22} /></button>
        {state.mode === "dictate" && onSubmitText ? (
          <button type="button" className="evi-ptt-icon evi-ptt-send" title={labels.submitText}
            aria-label={labels.submitText} disabled={active || !state.text.trim()}
            onClick={() => onSubmitText({ text: state.text.trim(), sessionKey: state.sessionKey })}>
            <Send aria-hidden size={20} />
          </button>
        ) : null}
      </div>
      <p id={`${id}-status`} className={state.error ? "evi-status is-error" : "evi-status"}
        role="status" aria-live="polite">{status}</p>
    </section>
  );
}
