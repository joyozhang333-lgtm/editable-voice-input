# Editable Voice Input

Record → transcribe → edit → submit.

Editable Voice Input is a small, provider-neutral toolkit for adding voice input to web products. It deliberately treats speech recognition as draft creation: the transcript is always editable and submission is always an explicit user action.

[中文说明](./README.zh-CN.md)

## Why this interaction model

- Recording is temporary and stays in memory unless the host application chooses otherwise.
- Transcription never auto-submits a message.
- The user can replay the recording, edit the transcript, retry, cancel, or submit.
- Browser capture, React UI, request validation, and transcription providers are separate packages.
- There is no telemetry, bundled speech model, account system, or storage layer.

## Packages

| Package | Purpose |
| --- | --- |
| `@editable-voice-input/core` | Browser capture, MIME negotiation, state and error types, object URL lifecycle, draft merging |
| `@editable-voice-input/react` | `useVoiceInput` plus accessible, minimal, themeable React components |
| `@editable-voice-input/server` | Framework-neutral raw-body limits, audio signature validation, and request handler |
| `@editable-voice-input/provider-openai-compatible` | Provider adapter for OpenAI-compatible transcription APIs |

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

- `examples/vite-react`: a client integration against a raw-audio endpoint.
- `examples/next-app-router`: a Next.js development demo using the server and provider packages. It deliberately returns 503 in production until `authorizeExample` is replaced with your authenticated session check.

All example text is fictional. No recording is uploaded until the user stops recording and requests transcription.

To run the Next development example, copy its `.env.example` to `.env.local`, provide a server-side provider key/base URL, then run `pnpm --filter editable-voice-input-example-next-app-router dev`. Its production route is intentionally disabled until you replace `authorizeExample` with your application's session check.

## Privacy contract

This library does not persist audio or transcripts and does not include telemetry. The current recording `Blob` is returned to the host so a product can deliberately implement retention if needed. If you store recordings, disclose retention, encrypt storage, authorize every read, and provide deletion controls. See [PRIVACY.md](./PRIVACY.md).

## Development

```bash
corepack pnpm install --frozen-lockfile
pnpm check
```

Releases are intended to use Changesets. This repository starts at `0.1.0-alpha.1`; no package is published automatically.

Before a future npm release, run `pnpm pack:release` and publish the generated tarballs from `release-packs/`. Do not run `npm pack` directly inside a workspace package: pnpm's pack step is what rewrites internal `workspace:*` dependencies to the concrete release version. CI installs all four generated tarballs into an empty npm project and verifies ESM, CommonJS, ESM/CommonJS declarations, and the exported stylesheet.

## License

MIT. See [LICENSE](./LICENSE).
