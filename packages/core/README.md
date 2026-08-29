# @editable-voice-input/core

Framework-neutral primitives for browser capture, editable streaming dictation, optional Web Speech recognition, authoritative batch reconciliation, playable audio-message metadata, and upload transports. No storage or network destination is bundled.

```ts
import { BrowserVoiceCapture } from "@editable-voice-input/core";

const capture = new BrowserVoiceCapture({ maxDurationMs: 120_000, maxBytes: 8 * 1024 * 1024 });
const session = await capture.start();
const audio = await session.stop(); // in-memory Blob; nothing is uploaded by core
capture.dispose();
```

Capture requires a secure browser context and a user gesture. Always offer cancel and make the resulting transcript editable before submission.

## Streaming dictation without edit loss

```ts
import {
  BrowserWebSpeechDictationProvider,
  applyDictationEdit,
  applyDictationResult,
  createEditableDictationDraft,
  runAuthoritativeDictationFallback
} from "@editable-voice-input/core";

let draft = createEditableDictationDraft("Typed first");
const provider = new BrowserWebSpeechDictationProvider();
const session = await provider.start({
  language: "en-US",
  onResult(result) {
    draft = applyDictationResult(draft, result);
    renderEditableValue(draft.value);
    renderInterimOnly(draft.interimText);
  }
});

// Mark every user-authored textarea change through the reducer.
draft = applyDictationEdit(draft, readTextarea());
await session.stop();

const outcome = await runAuthoritativeDictationFallback({
  draft,
  audio,
  transcribe
});
// outcome.resolution is "review-required" if the user edited.
```

Custom providers implement `DictationProvider`. A final result must contain only the newly finalized segment; interim results may replace the preceding interim hypothesis. Interim text is never mixed into `draft.value`.

## Direct audio transport

Implement `DirectAudioUploadTransport.upload()` to store a `CapturedAudio` and return a `DirectAudioMessage`. Its `audio` field contains `url`, `mimeType`, `durationMs`, and `size`, so any UI can render a player without provider-specific knowledge. Treat `clientMessageId` as an idempotency key and return it unchanged.

The built-in Web Speech provider may use a browser-vendor service. Feature-detect it and disclose the actual provider. It is not a replacement for a deterministic batch transcription endpoint.
