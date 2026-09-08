# @editable-voice-input/react

`PressToTalkInput` is the minimal, optional UI for a host-owned core `PressToTalkController`. It has one mode switch and recording area, plus a text-mode mic, editable draft, and optional explicit `onSubmitText({ text, sessionKey })`. Pass `controller`, optional `labels`, `className`, and `onSubmitText`. Unmount cancels pending work; hosts change account/conversation scope with `controller.setSession(...)` and dispose their controller when no longer needed. No transcription result ever invokes `onSubmitText`.

See the [full PressToTalk contract](../../docs/press-to-talk.md). Existing components and hooks remain unchanged.

React adapters for three compatible paths: the original batch `useVoiceInput`/`EditableVoiceInput`, live editable `useEditableDictation`, and first-class audio `useDirectAudioMessage`. `useDualModeVoiceInput` coordinates the latter two as a headless composer. All async actions are single-flight and late results are detached from cancelled operations.

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
  enableBrowserWebSpeech: true, // only after host disclosure/consent
  authoritativeTranscribe: transcribe
});

<textarea value={voice.value} onChange={(event) => voice.setValue(event.target.value)} />
<span aria-live="polite">{voice.interimText}</span>
```

Browser Web Speech is off by default. Pass `enableBrowserWebSpeech: true` explicitly, or inject a custom `provider`. When `authoritativeTranscribe` is present the hook captures audio in parallel, runs the batch transcriber after stop, and exposes the retained local preview as `audioUrl`. If live recognition is unsupported or fails, capture continues in `batch-only` mode and `liveError` records the non-fatal failure. An untouched draft accepts the batch result; an edited draft keeps its value and exposes `authoritativeSuggestion`, including edits made while the batch request is in flight.

## Direct audio

```tsx
const voice = useDirectAudioMessage({
  transport,
  uploadOnStop: false
});
```

Call `startRecording()`, `stopRecording()`, and then `send()`. The hook exposes the local `audioUrl` before upload and the validated server `message` afterward. A failed re-record start keeps the existing unsent recording and preview. `uploadOnStop` is opt-in and runs only for a user stop, never for `track-ended` or `page-hidden`. `clear()` aborts in-flight upload and invalidates late responses. A synchronously throwing or asynchronously rejecting `onMessage` callback is reported through `callbackError`/`onCallbackError` but cannot roll back the confirmed sent receipt.

Both new hooks accept an injectable `VoiceCaptureController` for native wrappers and deterministic tests. Web Speech is not universal—especially across iOS Safari versions—so feature-detect and retain the original batch component as a fallback where appropriate.

## Two-mode UI

`useDualModeVoiceInput` returns coordinated mode hooks plus a safe `setMode` that cancels the previous capture path. A shared start lock makes same-tick calls to both start methods single-microphone. `DualModeVoiceInput` is a minimal optional shell with ARIA tabs, arrow/Home/End keyboard behavior, editable text, direct-audio playback, and 44 px controls. Import `styles.css` or render your own product UI from the headless hook.
