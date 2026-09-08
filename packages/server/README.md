# @editable-voice-input/server

Framework-neutral helpers for bounded raw audio requests, metadata-based duration inspection, content signature validation, provider calls, and private no-store JSON responses.

**A playable browser Blob is not necessarily compatible with the default duration inspector.** In particular, live WebM can lack duration metadata and is rejected with HTTP 415 before provider use. See [duration inspection and live WebM](#duration-inspection-and-live-webm) before connecting MediaRecorder uploads.

The handler fails closed unless `authorize` is provided. `allowUnauthenticated: true` is available only for endpoints that are deliberately public. An `Origin` header is required and defaults to strict same-origin validation; `allowedOrigins` can explicitly add cross-origin clients. Non-browser server clients must deliberately set `allowMissingOrigin: true` and still authenticate. Use `consumeQuota` to apply a server-side per-user/IP rate or billing quota before audio is parsed or sent upstream.

```ts
const handle = createTranscriptionHandler({
  provider,
  authorize: async (request) => {
    const session = await readSession(request);
    if (!session) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  },
  consumeQuota: async (request) => rateLimiter.consume(request),
  maxDurationMs: 120_000,
  maxBytes: 8 * 1024 * 1024
});
```

Authentication and quota callbacks are integration points, not bundled identity or distributed rate-limit systems. In multi-instance deployments, back quotas with a shared atomic store.

Successful responses use `durationMs`. Providers that still return the deprecated `durationSeconds` field are accepted and normalized at the server boundary.

## Duration inspection and live WebM

`inspectAudioDurationMs` calls `music-metadata` with `{ duration: true }`. In the pinned version 11.15.0, the [Matroska parser](https://github.com/Borewit/music-metadata/blob/v11.15.0/lib/matroska/MatroskaParser.ts) obtains duration from Segment Info and skips audio clusters; that option does not derive missing WebM duration from frames. `MediaRecorder` can produce live/chunked WebM without this field. This is not necessarily empty or unplayable audio, and MIME support/signature validation does not establish duration availability. Other formats also require validation against the actual browser output; changing MIME is not a universal fix.

Missing, non-finite or non-positive duration yields HTTP **415**, `error.code: "invalid-audio-duration"`; duration above `maxDurationMs` yields HTTP **413**, `"audio-too-long"`. Neither path calls the transcription provider. Metadata inspection is not a complete decode or proof that untrusted metadata matches playback length. Browser capture timers and provider response metadata cannot replace pre-provider server validation.

### Inject a host inspector

The existing exported interface is:

```ts
type AudioDurationInspector = (
  audio: Uint8Array,
  mimeType: SupportedAudioMimeType
) => number | Promise<number>; // milliseconds, not seconds
```

Wire an independently implemented and tested host inspector into `createTranscriptionHandler`:

```ts
import {
  createTranscriptionHandler,
  type AudioDurationInspector
} from "@editable-voice-input/server";
// Host-owned implementation; this module is NOT supplied by the SDK.
import { inspectBoundedDecodedDurationMs } from "./host-audio-duration";

const inspectDurationMs: AudioDurationInspector = (audio, mimeType) =>
  inspectBoundedDecodedDurationMs(audio, mimeType);

const handle = createTranscriptionHandler({
  provider,
  authorize: authenticateHostRequest,
  consumeQuota: consumeHostQuota,
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 120_000,
  inspectDurationMs
});
```

The handler authenticates, consumes quota, bounds the request body and validates its signature/MIME before passing the full bytes and normalized MIME to the inspector. It still checks the returned duration before provider use. An ordinary thrown/rejected error becomes `invalid-audio-duration` (415); a `TranscriptionServerError` retains its public code/status, so do not put private decoder output in its message. `server.bundle.cjs` accepts the same `inspectDurationMs` option, but contains no FFmpeg executable or fallback decoder.

### Security requirements

- Inspect the uploaded bytes on the server. Never return a constant, trust client `durationMs`, estimate from compressed byte count, or clamp a longer duration to `maxDurationMs` to make it pass. Missing/invalid/unsupported/truncated input and failed inspection must fail closed.
- If using bounded PCM decoding (for example a host-managed FFmpeg process), validate the selected audio stream and output sample format/rate/channel count; count decoded samples, not container metadata or wall-clock recording time. Detect over-limit/truncated output and reject it rather than treating a partial decode as the full duration. No decoder implementation or command is validated or supplied here.
- Enforce input, decoded-output, CPU, memory, wall-clock and concurrency limits **inside the inspector/worker**. The API receives no `AbortSignal` or `maxDurationMs` argument; pass host limits through configuration/closures. The handler's post-return duration check is not a decoder resource limit. A `Promise.race` timeout alone does not terminate a worker/child process: stop and reap it on timeout/error and perform cleanup.
- Treat media as hostile: use maintained/sandboxed decoders with least privilege, disable network/external-resource access, restrict accepted protocols/formats and avoid shell interpolation of untrusted input. Keep authentication, Origin checks, quotas, byte/MIME limits and server duration enforcement enabled.
- Prefer bounded in-memory pipes. If temporary files are unavoidable, isolate permissions and remove them on success/failure; do not log or persist raw audio by default. Audio retention remains the host's policy, not an SDK feature.
- Test actual target-browser recordings through the real server inspector and provider, including durationless WebM, over-limit audio, malformed/truncated input and decoder timeouts. Browser tests with mocked transcription do not validate this boundary.
