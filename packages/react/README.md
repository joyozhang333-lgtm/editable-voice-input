# @editable-voice-input/react

React hook and minimal components for recording, transcribing into an editable draft, replaying, and explicit submission. Submission is single-flight; failures become the hook's controlled `error` state instead of escaping as unhandled promise rejections. Import `@editable-voice-input/react/styles.css` for the neutral default theme.

```tsx
import { EditableVoiceInput } from "@editable-voice-input/react";
import "@editable-voice-input/react/styles.css";

<EditableVoiceInput
  transcribe={async ({ blob, mimeType, signal }) => {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": mimeType },
      body: blob,
      signal
    });
    if (!response.ok) throw new Error("Transcription failed");
    return response.json();
  }}
  onSubmit={({ text }) => sendMessage(text)}
/>
```

Transcription only updates the editable draft. It never calls `onSubmit` automatically.
