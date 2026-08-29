# @editable-voice-input/react

React adapters for three compatible paths: the original batch `useVoiceInput`/`EditableVoiceInput`, live editable `useEditableDictation`, and first-class audio `useDirectAudioMessage`. All async actions are single-flight and late results are detached from cancelled operations.

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

## Live editable dictation

```tsx
const voice = useEditableDictation({
  value,
  onValueChange,
  language: "en-US",
  authoritativeTranscribe: transcribe
});

<textarea value={voice.value} onChange={(event) => voice.setValue(event.target.value)} />
<span aria-live="polite">{voice.interimText}</span>
```

The hook uses `BrowserWebSpeechDictationProvider` unless a custom `provider` is supplied. When `authoritativeTranscribe` is present it captures audio in parallel, runs the batch transcriber after stop, and exposes the retained local preview as `audioUrl`. An untouched draft accepts the batch result; an edited draft keeps its value and exposes `authoritativeSuggestion`.

## Direct audio

```tsx
const voice = useDirectAudioMessage({
  transport,
  uploadOnStop: false
});
```

Call `startRecording()`, `stopRecording()`, and then `send()`. The hook exposes the local `audioUrl` before upload and the validated server `message` afterward. `uploadOnStop` is opt-in. `clear()` aborts in-flight upload and invalidates late responses.

Both new hooks accept an injectable `VoiceCaptureController` for native wrappers and deterministic tests. Web Speech is not universal—especially across iOS Safari versions—so feature-detect and retain the original batch component as a fallback where appropriate.
