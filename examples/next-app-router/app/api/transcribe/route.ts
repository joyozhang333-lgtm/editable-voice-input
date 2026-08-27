import { createOpenAICompatibleProvider } from "@editable-voice-input/provider-openai-compatible";
import { createTranscriptionHandler } from "@editable-voice-input/server";

export const runtime = "nodejs";

const windowMs = 60_000;
const requestsPerWindow = 10;
const rateWindows = new Map<string, { count: number; resetAt: number }>();

function privateJson(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "private, no-store, max-age=0" } }
  );
}

function authorizeExample(_request: Request): Response | undefined {
  if (process.env.NODE_ENV === "production") {
    return privateJson(
      503,
      "authentication-not-configured",
      "Replace authorizeExample with your application's authenticated session check."
    );
  }
  return undefined;
}

function consumeExampleQuota(request: Request): Response | undefined {
  const now = Date.now();
  const key = request.headers.get("x-real-ip") ?? "local-development";
  const current = rateWindows.get(key);
  if (!current || current.resetAt <= now) {
    if (rateWindows.size >= 1_000) rateWindows.clear();
    rateWindows.set(key, { count: 1, resetAt: now + windowMs });
    return undefined;
  }
  current.count += 1;
  if (current.count > requestsPerWindow) {
    return privateJson(429, "rate-limited", "Too many transcription requests. Try again later.");
  }
  return undefined;
}

const handleTranscription = createTranscriptionHandler({
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 120_000,
  authorize: authorizeExample,
  consumeQuota: consumeExampleQuota,
  provider: createOpenAICompatibleProvider({
    apiKey: process.env.TRANSCRIPTION_API_KEY,
    baseUrl: process.env.TRANSCRIPTION_BASE_URL,
    model: process.env.TRANSCRIPTION_MODEL ?? "whisper-1",
    timeoutMs: 120_000
  })
});

export async function POST(request: Request): Promise<Response> {
  return handleTranscription(request);
}
