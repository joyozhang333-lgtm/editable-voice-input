# @editable-voice-input/provider-openai-compatible

Server-side multipart adapter for OpenAI-compatible audio transcription endpoints. It uses native `fetch`, does not log request content, and supports custom base URLs and paths.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`; credential-bearing URLs are rejected. Redirects are disabled and provider response bodies are bounded (256 KiB by default). Keep API keys in server-only environment variables.

```ts
import { createOpenAICompatibleProvider } from "@editable-voice-input/provider-openai-compatible";

const provider = createOpenAICompatibleProvider({
  apiKey: process.env.TRANSCRIPTION_API_KEY,
  baseUrl: "https://provider.example/v1",
  model: "whisper-1",
  timeoutMs: 120_000
});
```

Use this package on the server only. The adapter sends multipart audio and returns a normalized `{ text, language?, durationMs? }` result.
