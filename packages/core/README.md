# @editable-voice-input/core

`PressToTalkController` adds framework-neutral send/dictate intent, pointer hold/release/slide-cancel, editable draft reconciliation and session/abort fences. `bindPressToTalk` binds a native button with Pointer Capture and keyboard/assistive activation. Default capture reuses `BrowserVoiceCapture`; no Web Speech, network or persistence is enabled. `VoiceCaptureController` is now exported from core as well as the existing React path.

See the [API contract](../../docs/press-to-talk.md) and [中文接口](../../docs/press-to-talk.zh-CN.md). Build standalone browser IIFE/ESM and Node server/provider CJS via `pnpm build:vendor` from the repository root; verify with `pnpm vendor:check`.

Framework-neutral primitives for browser capture, editable streaming dictation, optional Web Speech recognition, authoritative batch reconciliation, playable audio-message metadata, exact-reconcile outboxes, and upload transports. No storage or network destination is enabled by default.

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
// Construct this only after the host has disclosed browser-vendor processing.
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

The built-in Web Speech provider may use a browser-vendor service. Feature-detect it and disclose the actual provider. It is not a replacement for a deterministic batch transcription endpoint. Its session restarts after a natural `onend` while listening intent remains active.

## Durable outbox

`DirectAudioOutbox` stages stable `clientTurnId` records, calls `transport.find()` before every upload attempt, and removes the record only after validating a server message. A validated server response remains a successful durable receipt even if local cleanup aborts; `cleanupPending: true` tells the host that reconciliation will retry, and the send lease is released immediately so recovery does not wait for its TTL. Two tabs can still race after both lookups return empty, so the upload server must atomically enforce `(owner, clientTurnId)` uniqueness. `clear()` advances an internal generation, asks active transports to abort, and fences local persistence/upload continuations. This is best-effort once a request reaches the server; strong revocation requires a server-side epoch/revocation check at the write boundary.

`createIndexedDbDirectAudioOutboxStore` requires an injected codec plus an opaque owner `partition`; its composite keys and all reads/deletes/clears are partition-scoped. A persistent partition epoch is captured before asynchronous encoding and CASed in the final write transaction, so another tab's `clear()` cannot be undone by a late write. Sends hold a durable epoch/revision lease and conditionally delete only the row they actually sent. `claimTo()` CASes source and target epochs in one atomic re-key transaction and accepts an abort signal that remains active through commit. Custom store names coordinate through IndexedDB version upgrades across module realms: connections close on `versionchange`, reopen, and retry interrupted schema/row transactions. A custom name that collides with an incompatible host store fails closed; the library never deletes that host store. Create a new instance on identity change. Use the codec to encrypt audio and bind owner identity, and never pass a raw account identifier as the partition. Core intentionally does not know product conversations, sessions, or accounts.

Every public duration is `durationMs`. Older direct-audio responses containing `durationSeconds` remain readable and are normalized at the boundary.
