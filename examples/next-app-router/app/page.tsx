"use client";

import { EditableVoiceInput, type Transcriber } from "@editable-voice-input/react";
import { useState } from "react";

const transcribe: Transcriber = async ({ blob, mimeType, signal }) => {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": mimeType },
    body: blob,
    signal
  });
  const payload = (await response.json()) as { text?: string; error?: { message?: string } };
  if (!response.ok || !payload.text) {
    throw new Error(payload.error?.message ?? "Transcription failed");
  }
  return { text: payload.text };
};

export default function Page() {
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");

  return (
    <main>
      <header>
        <span>Editable Voice Input</span>
        <h1>Speak naturally. Edit deliberately.</h1>
        <p>Try a fictional note such as “Pick up flowers after lunch.” Nothing submits itself.</p>
      </header>
      <EditableVoiceInput
        value={draft}
        onValueChange={setDraft}
        transcribe={transcribe}
        onSubmit={({ text }) => setSubmitted(text)}
      />
      {submitted ? (
        <section className="submitted" aria-live="polite">
          <span>Explicitly submitted</span>
          <p>{submitted}</p>
        </section>
      ) : null}
    </main>
  );
}
