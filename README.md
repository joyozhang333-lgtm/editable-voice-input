# Editable Voice Input

Speak → edit text, or send the recording itself.

Editable Voice Input is a small, provider-neutral toolkit for adding voice input to web products. It supports two distinct product contracts: editable dictation and direct audio messages. Text remains editable and audio remains a first-class message instead of the two paths being silently conflated.

[中文说明](./README.zh-CN.md)

## Why this interaction model

- Recording is temporary and stays in memory unless the host explicitly stages it in an outbox.
- Transcription never auto-submits a message.
- The user can replay the recording, edit the transcript, retry, cancel, or submit.
- Browser capture, React UI, request validation, and transcription providers are separate packages.
- Live interim speech is never written over the editable value.
- A post-stop batch transcript replaces streaming text only if the user has not edited it.
- Direct audio upload is an injected transport; the library does not choose storage or retention.
- There is no telemetry, bundled speech model, account system, or storage enabled by default.

## Packages

| Package | Purpose |
| --- | --- |
| `@editable-voice-input/core` | Capture, editable dictation reducer, optional Web Speech provider, batch reconciliation, direct-audio contracts |
| `@editable-voice-input/react` | Legacy `useVoiceInput`, `useEditableDictation`, `useDirectAudioMessage`, and minimal components |
| `@editable-voice-input/server` | Framework-neutral raw-body limits, audio signature validation, and request handler |
| `@editable-voice-input/provider-openai-compatible` | Provider adapter for OpenAI-compatible transcription APIs |
| `@editable-voice-input/adapter-guichu` | GuiChu Here conversation/session/owner adapter, isolated from core |

`@editable-voice-input/adapter-guichu` is a reference host-integration contract, not a GuiChu/V0954 backend. It does not ship server routes, receipt persistence, database migrations, or evidence that any production app has integrated the package. A host must implement and transaction-test those boundaries before claiming end-to-end delivery.

V0954 currently uses its own voice implementation and does not import this SDK.

## Quick start

```tsx
import { EditableVoiceInput } from "@editable-voice-input/react";
import "@editable-voice-input/react/styles.css";

export function Composer() {
  const [draft, setDraft] = useState("");

  return (
    <EditableVoiceInput
      value={draft}
      onValueChange={setDraft}
      transcribe={async ({ blob, mimeType }) => {
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "content-type": mimeType },
          body: blob
        });
        if (!response.ok) throw new Error("Transcription failed");
        return response.json();
      }}
      onSubmit={({ text }) => sendMessage(text)}
    />
  );
}
```

The component does not call `onSubmit` after transcription. Only the visible submit button or the hook's explicit `submit()` method can do that.

## Editable live dictation

`useEditableDictation` accepts any `DictationProvider`. Browser Web Speech is disabled by default because a browser vendor may process the audio; the host must disclose that processing and explicitly pass `enableBrowserWebSpeech: true`. Interim hypotheses are exposed as `interimText`; only final segments enter the editable value. Adding `authoritativeTranscribe` records temporary audio in parallel and runs a batch transcription after stop.

```tsx
const dictation = useEditableDictation({
  value: draft,
  onValueChange: setDraft,
  language: "en-US",
  enableBrowserWebSpeech: true, // only after your product's disclosure/consent step
  authoritativeTranscribe: transcribeThroughYourServer
});

<textarea value={dictation.value} onChange={(event) => dictation.setValue(event.target.value)} />
<span aria-live="polite">{dictation.interimText}</span>
<button onClick={dictation.state === "listening" ? dictation.stopDictation : dictation.startDictation}>
  {dictation.state === "listening" ? "Stop" : "Dictate"}
</button>
```

If the user edits while speaking, the batch result is placed in `authoritativeSuggestion` and never overwrites `value`. A host can show a compare/accept UI. If the draft is untouched, the batch result is applied automatically.

The built-in Web Speech provider is optional and browser-dependent. It restarts after a browser ends recognition on silence while the user still intends to listen. If it is unavailable or errors and `authoritativeTranscribe` is configured, recording continues in `batch-only` mode; the failure is exposed as non-fatal `liveError`. You can instead inject a native, WebSocket, on-device, or vendor SDK provider through the same `DictationProvider` contract.

## Headless two-mode composer

`useDualModeVoiceInput` coordinates editable dictation and direct audio without allowing both capture paths to remain active, including same-tick calls to both headless start methods. `DualModeVoiceInput` is an optional minimal UI with keyboard tabs and 44 px touch targets; product teams can use the headless hook and render their own interface.

## Direct audio messages

`useDirectAudioMessage` captures a recording, creates a stable client message ID, and calls an injected upload transport. The transport returns server-owned, playable metadata. Upload is explicit by default; set `uploadOnStop: true` only when the UI clearly communicates that stopping sends the recording.

```tsx
const audioMessage = useDirectAudioMessage({
  transport: {
    async upload({ audio, clientMessageId, signal }) {
      const response = await fetch(`/api/audio-messages/${clientMessageId}`, {
        method: "PUT",
        headers: { "content-type": audio.mimeType },
        body: audio.blob,
        signal
      });
      if (!response.ok) throw new Error("Audio upload failed");
      return response.json(); // DirectAudioMessage with audio.url/durationMs/mimeType/size
    }
  }
});
```

The server should treat `clientMessageId` as an idempotency key and must authorize upload and playback separately. The core validates that the returned message echoes this ID, preventing a late response from attaching to a different local recording.

### Durable direct-audio reconciliation

`DirectAudioOutbox` stages a recording under a stable `clientTurnId`, performs an exact owner-authorized lookup before upload, and only deletes the pending record after a validated server message exists. A lost upload response can therefore recover on refresh. A validated upload response is treated as a durable receipt: if local IndexedDB cleanup aborts, `send()` still succeeds with `cleanupPending: true`, leaves the row recoverable, and retries exact reconciliation later. Exactly-once creation across tabs or devices also requires an atomic server unique constraint on `(owner, clientTurnId)`; concurrent upload conflicts must return the existing message.

Durability is injected through `DirectAudioOutboxStore`. `createIndexedDbDirectAudioOutboxStore` is available for browsers, but requires both a codec and an opaque `partition` for the current owner. Rows use a composite `(partition, clientTurnId)` key; `get`, `list`, `delete`, and `clear` are scoped to that partition. A durable partition epoch makes `clear()` atomic with row deletion and prevents delayed cross-tab encodes from restoring stale rows. Each send also acquires a persisted partition-epoch + row-revision lease, rechecks it around lookup and immediately before upload, and uses it for conditional cleanup. `claimTo()` atomically CASes source and target epochs while moving and re-encrypting a record, so an old tab cannot continue after clear or claim. Multiple custom `storeName` values coordinate through IndexedDB version upgrades; every realm closes on `versionchange`, then reopens and retries interrupted schema/row transactions. An incompatible custom key path fails closed and is never deleted or rewritten. Create a new store instance when identity changes and never use a raw account identifier as the partition. The host codec must encrypt the record, bind the current identity as authenticated data, expire abandoned records, and reject account changes. The memory store is for tests and non-durable demos only.

GuiChu-specific `conversationId`, `sessionId`, and `ownerKey` live in `@editable-voice-input/adapter-guichu`, not in core. The adapter seals the original scope into outbox metadata and fails closed for legacy pending rows without that scope. It requires an `identityEpoch` plus host-aborted `identitySignal`; it checks the epoch before and after exact lookup/upload and supports an optional server identity preflight. Account changes must call `outbox.clear()` before activating the new owner, or use the adapter's authenticated guest-to-account claim helper. That helper links the source identity signal, target identity signal, and caller cancellation across the server wait and local IndexedDB move. It first requires an idempotent server `claimOrReconcile` receipt which atomically reconciles an existing guest message or reserves the turn for the account and revokes source writes for that turn; the receipt must echo both sides' conversation, session, owner, identity epoch, and the client turn before the local row can move. A response-loss retry must return the same durable receipt.

The claim helper moves exactly one `clientTurnId`. For several pending rows, the host must enumerate them before identity transition and either obtain one durable server batch grant or keep per-turn source authorization valid while claiming each row. Do not destroy or globally revoke the source identity after the first row; finish every selected claim, then finalize the batch. This package intentionally does not pretend to orchestrate that host transaction. `clear()` is a best-effort client fence: it invalidates local stage/send continuations and asks active transports to abort, but it cannot retract a request already delivered over the network. Strong revocation therefore requires a server-side identity epoch/revocation check in the same transaction as `findExact`, `upload`, and claim reconciliation.

### Server route

```ts
import { createTranscriptionHandler } from "@editable-voice-input/server";
import { createOpenAICompatibleProvider } from "@editable-voice-input/provider-openai-compatible";

const handle = createTranscriptionHandler({
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 120_000,
  authorize: async (request) => {
    const session = await readSession(request);
    if (!session) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  },
  consumeQuota: async (request) => rateLimiter.consume(request),
  provider: createOpenAICompatibleProvider({
    apiKey: process.env.TRANSCRIPTION_API_KEY!,
    baseUrl: process.env.TRANSCRIPTION_BASE_URL,
    model: process.env.TRANSCRIPTION_MODEL ?? "whisper-1"
  })
});

export const POST = handle;
```

Keep provider credentials on the server. The handler requires an authentication callback unless you explicitly opt into a public endpoint. It requires an `Origin` header and validates same-origin by default; non-browser clients must explicitly enable missing-origin requests and remain authenticated. Configure allowed cross-origins and a shared, atomic quota implementation for your own deployment model.

## Browser support

The capture layer negotiates formats in this order: Opus WebM, WebM, MP4, Opus Ogg, Ogg. Safari commonly selects MP4; Chromium commonly selects WebM. Capture requires HTTPS (or localhost) and user-granted microphone permission.

Default limits are 120 seconds and 8 MiB. Hosts can lower them. The server package verifies the declared content type, file signature, and real container duration before calling the transcription provider.

Web Speech recognition availability is separate from MediaRecorder support. Chromium generally exposes it; iOS Safari support and behavior vary by OS version and may stop on silence or when the page backgrounds. Always feature-detect, retain typed text, and keep batch-only dictation as a fallback. Capture safely stops when its media track ends or the page is hidden/unloaded. Lifecycle-stopped audio is marked with a `terminationReason`, remains reviewable while the page survives, and is never treated as an explicit stop-to-send action.

## Styling

The React components use CSS custom properties and neutral defaults. Override them on `.evi-root`:

```css
.my-composer {
  --evi-accent: #64584a;
  --evi-surface: #faf9f7;
  --evi-radius: 16px;
}
```

Interactive targets are at least 44 px and textarea text is 16 px by default for comfortable mobile use.

## Examples

- `examples/vite-react`: both editable dictation and a memory-only direct-audio transport.
- `examples/next-app-router`: a Next.js development demo using the server and provider packages. It deliberately returns 503 in production until `authorizeExample` is replaced with your authenticated session check.

All example text and IDs are fictional. The Vite direct-audio demo creates only tab-scoped object URLs. No real storage service, recording, account, or credential is included.

The Vite editable-dictation demo proxies `/api/transcribe` to `http://localhost:3001`. Start a compatible raw-audio transcription endpoint there before testing its batch fallback. The direct-audio tab is memory-only and does not require that proxy.

To run the Next development example, copy its `.env.example` to `.env.local`, provide a server-side provider key/base URL, then run `pnpm --filter editable-voice-input-example-next-app-router dev`. Its production route is intentionally disabled until you replace `authorizeExample` with your application's session check.

## Privacy contract

This library does not persist audio or transcripts unless the host explicitly creates and uses an outbox store, and it does not include telemetry. Browser Web Speech implementations may send speech to the browser vendor; it is off by default, so disclose and obtain consent before enabling it. The current recording `Blob` is returned to the host so a product can deliberately implement retention if needed. If you store recordings, disclose retention, encrypt storage, authorize every read, and provide deletion and export controls. See [PRIVACY.md](./PRIVACY.md).

## Development

```bash
corepack pnpm install --frozen-lockfile
pnpm check
```

This branch remains in Changesets `beta` prerelease mode at `0.2.0-beta.1`; no package is published automatically. Do not run a stable version/publish step until physical mobile-browser QA is complete.

Before a future npm release, run `pnpm pack:release` and publish the generated tarballs from `release-packs/`. Do not run `npm pack` directly inside a workspace package: pnpm's pack step is what rewrites internal `workspace:*` dependencies to the concrete release version. CI installs all five generated tarballs into an empty npm project and verifies ESM, CommonJS, ESM/CommonJS declarations, and the exported stylesheet.

## License

MIT. See [LICENSE](./LICENSE).
