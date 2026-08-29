import {
  useDirectAudioMessage,
  useEditableDictation,
  type DirectAudioUploadTransport,
  type Transcriber
} from "@editable-voice-input/react";
import { useEffect, useMemo, useRef, useState } from "react";

const transcribe: Transcriber = async ({ blob, mimeType, signal }) => {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": mimeType },
    body: blob,
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error("Transcription is temporarily unavailable");
  return response.json();
};

type DemoMode = "dictation" | "audio";

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function App() {
  const [mode, setMode] = useState<DemoMode>("dictation");
  const [submitted, setSubmitted] = useState("");
  const demoUrlsRef = useRef<string[]>([]);
  const localTransport = useMemo<DirectAudioUploadTransport>(
    () => ({
      async upload({ audio, clientMessageId }) {
        const url = URL.createObjectURL(audio.blob);
        demoUrlsRef.current.push(url);
        return {
          id: `demo-${clientMessageId}`,
          clientMessageId,
          kind: "audio",
          createdAt: new Date().toISOString(),
          audio: {
            url,
            mimeType: audio.mimeType,
            durationMs: audio.durationMs,
            size: audio.size
          },
          metadata: { storage: "memory-only-demo" }
        };
      }
    }),
    []
  );

  const dictation = useEditableDictation({
    defaultValue: "",
    language: "zh-CN",
    authoritativeTranscribe: transcribe
  });
  const directAudio = useDirectAudioMessage({
    transport: localTransport,
    metadata: { example: "anonymous-synthetic-demo" }
  });

  useEffect(() => {
    if (mode === "dictation") directAudio.cancel();
    else dictation.cancel();
  }, [mode]);

  useEffect(() => {
    return () => {
      for (const url of demoUrlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const dictationBusy = ["starting", "stopping", "transcribing"].includes(dictation.state);
  const audioBusy = ["requesting-permission", "stopping", "uploading"].includes(
    directAudio.state
  );

  return (
    <main className="example-shell">
      <div className="example-copy">
        <p className="example-eyebrow">Editable Voice Input</p>
        <h1>Two voice paths, one deliberate composer.</h1>
        <p>
          Try a fictional note. Dictation keeps live hypotheses separate from editable text; direct
          audio returns a playable message without pretending it is text.
        </p>
      </div>

      <div className="example-tabs" role="tablist" aria-label="Voice mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "dictation"}
          onClick={() => setMode("dictation")}
        >
          Editable dictation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "audio"}
          onClick={() => setMode("audio")}
        >
          Direct audio
        </button>
      </div>

      {mode === "dictation" ? (
        <section className="example-card" role="tabpanel">
          <label htmlFor="dictation-draft">Editable draft</label>
          <textarea
            id="dictation-draft"
            value={dictation.value}
            onChange={(event) => dictation.setValue(event.currentTarget.value)}
            placeholder="Type, or start speaking"
          />
          {dictation.interimText ? (
            <p className="example-interim" aria-live="polite">
              {dictation.interimText}
            </p>
          ) : null}
          {dictation.authoritativeSuggestion ? (
            <div className="example-suggestion">
              <span>Batch transcript kept as a suggestion because you edited the draft</span>
              <p>{dictation.authoritativeSuggestion}</p>
            </div>
          ) : null}
          {dictation.audioUrl ? (
            <audio controls preload="metadata" src={dictation.audioUrl}>
              Recorded dictation preview
            </audio>
          ) : null}
          <div className="example-actions">
            <button
              type="button"
              onClick={
                dictation.state === "listening"
                  ? dictation.stopDictation
                  : () => void dictation.startDictation()
              }
              disabled={dictationBusy}
            >
              {dictation.state === "listening" ? "Stop" : "Start dictation"}
            </button>
            {dictation.state === "listening" ? (
              <span className="example-duration">{formatDuration(dictation.elapsedMs)}</span>
            ) : null}
            <button type="button" className="is-quiet" onClick={dictation.cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={!dictation.value.trim() || dictationBusy || dictation.state === "listening"}
              onClick={() => setSubmitted(dictation.value.trim())}
            >
              Submit text
            </button>
          </div>
          <p className={dictation.error ? "example-status is-error" : "example-status"}>
            {dictation.error?.message ?? `State: ${dictation.state}`}
          </p>
        </section>
      ) : (
        <section className="example-card" role="tabpanel">
          <p className="example-description">
            Record first, review locally, then explicitly upload. This demo transport keeps the Blob
            in this browser tab.
          </p>
          {directAudio.audioUrl ? (
            <audio controls preload="metadata" src={directAudio.audioUrl}>
              Local audio preview
            </audio>
          ) : null}
          <div className="example-actions">
            <button
              type="button"
              onClick={
                directAudio.state === "recording"
                  ? directAudio.stopRecording
                  : () => void directAudio.startRecording()
              }
              disabled={audioBusy}
            >
              {directAudio.state === "recording" ? "Stop" : "Record audio"}
            </button>
            {directAudio.state === "recording" ? (
              <span className="example-duration">{formatDuration(directAudio.elapsedMs)}</span>
            ) : null}
            <button type="button" className="is-quiet" onClick={directAudio.cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={!directAudio.audio || audioBusy || directAudio.state === "recording"}
              onClick={() => void directAudio.send()}
            >
              Send audio
            </button>
          </div>
          <p className={directAudio.error ? "example-status is-error" : "example-status"}>
            {directAudio.error?.message ?? `State: ${directAudio.state}`}
          </p>
          {directAudio.message ? (
            <div className="example-result" aria-live="polite">
              <span>Playable message metadata returned</span>
              <audio controls preload="metadata" src={directAudio.message.audio.url}>
                Uploaded audio message
              </audio>
            </div>
          ) : null}
        </section>
      )}

      {submitted ? (
        <aside className="example-result" aria-live="polite">
          <span>Explicitly submitted text</span>
          <p>{submitted}</p>
        </aside>
      ) : null}
    </main>
  );
}
