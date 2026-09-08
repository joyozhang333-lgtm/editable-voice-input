# PressToTalk Contract

[中文](./press-to-talk.zh-CN.md)

`PressToTalkController` is framework-neutral and uses the existing `BrowserVoiceCapture` (MediaRecorder) by default. It does not use Web Speech, perform network requests, store recordings, or send transcript results. The `VoiceCaptureController` injection interface is now exported by core; the existing React type export remains compatible.

## Host Boundary

```ts
import { PressToTalkController, bindPressToTalk } from "@editable-voice-input/core";

const voice = new PressToTalkController({
  sessionKey: "anonymous-demo-session",
  defaultMode: "send",       // "send" | "dictate"
  defaultText: "",
  cancelDistancePx: 64,
  async onCommit({ audio, intent, sessionKey, recordingId, signal, source }) {
    // audio: { blob, mimeType, durationMs, size, terminationReason? }
    // source: "pointer" | "activation"
    const result = await transcribeThroughHost(audio, { signal });
    if (signal.aborted) return;
    if (intent === "dictate") return { text: result.text };
    await hostSend({ audio, text: result.text, sessionKey, recordingId, signal });
  }
});
const unbind = bindPressToTalk(document.querySelector<HTMLButtonElement>("#hold")!, voice);
const unsubscribe = voice.subscribe(() => render(voice.getSnapshot()));
render(voice.getSnapshot());
```

`onCommit` returns `void | string | TranscriptionResult` or a Promise of that union. Only the dictate branch consumes returned text. Send return values never modify the draft. There is at most one callback per recording and no automatic retry. `idle` after the callback means host processing returned, not that a server receipt was verified. A host whose send result is uncertain must reconcile by `recordingId`, not blindly create another message.

For audio-plus-text messages, the send callback can transcribe first and then enter the host's existing send workflow. A host may keep playable audio only in its own identity-partitioned IndexedDB and send a text copy to its server. Neither the controller nor these examples enable persistence. Audio necessarily passes through transient server/provider memory for server transcription; the host is responsible for provider retention policy, authorization, local encryption, deletion, and exports. No audio-storage endpoint is added.

## Methods

| Method | Contract |
| --- | --- |
| `pointerDown({pointerId, clientY, button?, isPrimary?})` | Returns a boolean indicating whether the primary pointer was accepted; starts in the current mode, default send. |
| `pointerMove({pointerId, clientY})` | Arms cancel at 64 CSS px upward by default; moving back disarms it. |
| `pointerUp({pointerId, clientY})` | Checks the final position and only commits a recording that actually started. |
| `pointerCancel(pointerId)` | Cancels only the owning pointer. |
| `start({intent?} = {})` | Promise of void; click/keyboard alternative that does not require holding a key. Defaults to the current mode. |
| `stop()` | Explicit stop using this take's intent. In send mode the button must communicate stop-to-send. Pending permission or armed cancel cancels instead. |
| `stopToDictate()` | Changes the active recording to dictate and stops it. Pending permission is cancelled, never replayed. |
| `setMode("send" | "dictate")` | A mode change cancels in-flight work and preserves the text draft. Setting the same mode is a no-op. |
| `setText(text)` | Registers an edit revision, including edits that restore the original value. |
| `setSession(sessionKey, text = "")` | Always invalidates capture and asynchronous work, even with the same key; replaces the draft. |
| `cancel()` | Invalidates capture and host work, preserving the draft. |
| `getSnapshot()` | Stable, frozen snapshot until a change. |
| `subscribe(listener)` | Change notifications; returns unsubscribe. Read the first snapshot yourself. |
| `dispose()` | Terminal cleanup; create another controller to reuse. |

Snapshot fields: `phase`, `mode`, `text`, `transcriptSuggestion`, `cancelPending`, `sessionKey`, `recordingId`, `elapsedMs`, `error`. Phases: `idle`, `requesting-permission`, `recording`, `stopping`, `transcribing`, `committing`, `error`.

Use `bindPressToTalk(button, controller)` for Pointer Capture, `pointercancel`/`lostpointercapture`, native Enter/Space or assistive activation, repeat suppression, Escape, and compatibility-click suppression. It sets/restores `touch-action` and `user-select`; its cleanup cancels work but does not terminally dispose the controller. The host supplies accessible labels, state feedback, and a visible click alternative (the React text-mode mic is one). Custom bindings must capture the accepted pointer, forward final coordinates and cancellation, and must not interpret the pointer's compatibility click as a second start. See the [Pointer Capture documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture) and [pointercancel documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event).

## Safety Rules

- Releasing before microphone permission resolves invalidates that attempt. Late permission only releases tracks, never records/sends retroactively.
- Cancellation, hidden documents, pagehide, dispose, and mode/session changes fence both capture and host continuations. Lifecycle fencing stays active through final MediaRecorder events and the host callback, even if capture lifecycle options are disabled.
- A duration limit, lost track, or another automatic stop never commits. Even custom capture adapters without `terminationReason` require explicit controller stop intent. Adapters should always supply the termination reason.
- Dictation uses the draft and edit revision from recording start. An untouched draft receives the appended transcript. Any user edit puts the result in `transcriptSuggestion` instead. A stale recording or session discards the result entirely, even if the host ignores abort.
- The host must use the captured `sessionKey`, recheck `signal.aborted` and identity after every await before side effects, and invalidate on account changes via `setSession`. Cancellation cannot retract a request already delivered; authorization and idempotent server writes remain host responsibilities.
- The controller never calls a text-send callback. Accepting/using a suggestion or submitting typed text is a separate host action.

## React

```tsx
import { PressToTalkInput } from "@editable-voice-input/react";
import "@editable-voice-input/react/styles.css";

<PressToTalkInput controller={voice}
  onSubmitText={({ text, sessionKey }) => hostSendText({ text, sessionKey })}
  labels={{ hold: "按住说话，松开发送", release: "松开发送", edit: "转文字" }} />
```

The controller is owned by the host, not recreated on each render. Update its scope with `setSession`; the component cancels on unmount. It has one mode switch and recording area, no mode tabs. Text mode provides an editable textarea and click/keyboard mic. The recording-to-text action calls `stopToDictate`, never send. All labels can be localized; the example above overrides only three, so localize the other accessible/status labels in your product too.

## Vendor Builds

```sh
pnpm install --frozen-lockfile
pnpm build:vendor
pnpm vendor:check
```

Outputs in `dist/vendor/`:

- `press-to-talk.iife.js`: `<script>` global `window.EditableVoiceInputCore`.
- `press-to-talk.js`: self-contained browser ESM with `PressToTalkController`, `bindPressToTalk`, `BrowserVoiceCapture`, capture utilities and error/state constants. No React, Web Speech, or outbox implementation is included.
- `server.bundle.cjs`: self-contained Node 20+ CommonJS with both `createTranscriptionHandler` and `createOpenAICompatibleProvider`, including duration-inspection dependencies. Never load this in the browser or put provider credentials in client code.
- `LICENSE`, `THIRD_PARTY_NOTICES.md`, `package.json`, `manifest.json`: keep the notices and use the version/byte count/SHA-256 manifest to pin a vendored copy. Build output is ignored by Git and reproducible from source; no npm publication is performed.

```js
const { createTranscriptionHandler, createOpenAICompatibleProvider } = require("./server.bundle.cjs");
const POST = createTranscriptionHandler({
  authorize: authenticateHostRequest,
  consumeQuota: consumeHostQuota,
  provider: createOpenAICompatibleProvider({ apiKey: process.env.TRANSCRIPTION_API_KEY })
});
```

`POST` consumes a standard `Request` and returns a `Response`. A Node HTTP framework must adapt its request/response without bypassing the existing bounded-body, Origin, authentication, quota and duration validation. The included handler does not persist recordings. `vendor:check` imports IIFE/ESM and executes the CJS handler with real synthetic WAV duration parsing and a mock provider in a directory without node_modules, rejecting non-builtin runtime requires.

**The bundled default inspector does not accept every browser Blob.** Live WebM may play correctly but lack duration metadata; `inspectAudioDurationMs` then returns 415 before ASR. `duration: true` does not fix this in the pinned Matroska parser. Inject a host-validated `AudioDurationInspector` as `inspectDurationMs` when needed; see the [interface, example and resource/security requirements](../packages/server/README.md#duration-inspection-and-live-webm). No fallback decoder is bundled, and mocked browser transcription tests do not establish real server/container compatibility.

## Examples and Verification

- `examples/vite-react`: the new minimal composer; `/api/transcribe` proxies to localhost:3001. Start a host transcription endpoint there for real transcription.
- `examples/vite-react/src/LegacyApp.tsx` and `legacy.css`: previous dual-mode reference example, retained as source.
- `examples/vanilla`: plain script integration using the IIFE. `pnpm dev:vanilla` serves it on localhost:5188; to transcribe, serve it behind a host route at `/api/transcribe`. The static demo server deliberately has no transcription/storage endpoint.
- `pnpm test:browser`: Chromium desktop and mobile-touch emulation, using synthetic microphone input and intercepted transcription responses. Install Chromium first with `pnpm exec playwright install chromium`.

Automated browser tests are not physical iOS Safari, Android Chrome, in-app WeChat, screen-reader device, or real-provider verification. Permission prompts, interruptions, device locking, backgrounding, MIME/playback and long presses must still be tested on real phones before a stable release.
