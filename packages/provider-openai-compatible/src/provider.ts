import type {
  ProviderTranscriptionInput,
  ProviderTranscriptionResult,
  TranscriptionProvider
} from "@editable-voice-input/server";

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  path?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: HeadersInit;
  fetch?: typeof globalThis.fetch;
}

export class OpenAICompatibleProviderError extends Error {
  readonly status?: number;
  readonly cause?: unknown;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    if (options?.status !== undefined) this.status = options.status;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

function endpointUrl(baseUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  } catch (error) {
    throw new TypeError("baseUrl and path must form a valid URL.", { cause: error });
  }
  if (url.username || url.password) {
    throw new TypeError("Provider URLs must not contain credentials.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && loopbackHosts.has(url.hostname);
  if (!secure && !localHttp) {
    throw new TypeError("Provider URLs must use HTTPS, except HTTP loopback endpoints.");
  }
  return url.toString();
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function parseProviderResponse(raw: string): ProviderTranscriptionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const text = raw.trim();
    if (text) return { text };
    throw new OpenAICompatibleProviderError("The transcription provider returned no text.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new OpenAICompatibleProviderError("The transcription provider returned an invalid response.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string" || !record.text.trim()) {
    throw new OpenAICompatibleProviderError("The transcription provider returned no text.");
  }
  const result: ProviderTranscriptionResult = { text: record.text };
  if (typeof record.language === "string") result.language = record.language;
  const duration = record.duration ?? record.duration_seconds;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    result.durationSeconds = duration;
  }
  return result;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new OpenAICompatibleProviderError("The transcription provider response was too large.");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response-too-large");
        throw new OpenAICompatibleProviderError(
          "The transcription provider response was too large."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions = {}
): TranscriptionProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new TypeError("A fetch implementation is required.");
  const url = endpointUrl(
    options.baseUrl ?? "https://api.openai.com/v1",
    options.path ?? "/audio/transcriptions"
  );
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number.");
  }
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("maxResponseBytes must be a positive safe integer.");
  }
  const model = options.model ?? "whisper-1";

  return {
    async transcribe(input: ProviderTranscriptionInput): Promise<ProviderTranscriptionResult> {
      const form = new FormData();
      form.set("file", new Blob([copiedBuffer(input.audio)], { type: input.mimeType }), input.filename);
      form.set("model", model);
      form.set("response_format", "json");
      if (input.language) form.set("language", input.language);

      const headers = new Headers(options.headers);
      headers.delete("content-type");
      if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
      const controller = new AbortController();
      const abortFromInput = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) abortFromInput();
      else input.signal?.addEventListener("abort", abortFromInput, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("Provider timeout")), timeoutMs);

      try {
        const response = await fetchImplementation(url, {
          method: "POST",
          headers,
          body: form,
          signal: controller.signal,
          redirect: "error"
        });
        if (!response.ok) {
          throw new OpenAICompatibleProviderError(
            `The transcription provider returned HTTP ${response.status}.`,
            { status: response.status }
          );
        }
        return parseProviderResponse(await readBoundedResponse(response, maxResponseBytes));
      } catch (error) {
        if (error instanceof OpenAICompatibleProviderError) throw error;
        throw new OpenAICompatibleProviderError("The transcription provider request failed.", {
          cause: error
        });
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abortFromInput);
      }
    }
  };
}
