import { readBoundedBody } from "./body";
import { inspectAudioDurationMs, type AudioDurationInspector } from "./duration";
import { extensionForAudioMime, validateAudioMime } from "./mime";
import {
  TranscriptionServerError,
  type SupportedAudioMimeType,
  type TranscriptionProvider
} from "./types";

export const DEFAULT_SERVER_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SERVER_MAX_DURATION_MS = 120_000;

export interface TranscriptionHandlerOptions {
  provider: TranscriptionProvider;
  maxBytes?: number;
  maxDurationMs?: number;
  inspectDurationMs?: AudioDurationInspector;
  allowedMimeTypes?: readonly SupportedAudioMimeType[];
  allowedOrigins?: readonly string[] | ((origin: string) => boolean);
  allowedRequestHeaders?: readonly string[];
  allowMissingOrigin?: boolean;
  authorize?: (request: Request) => void | Response | Promise<void | Response>;
  allowUnauthenticated?: boolean;
  consumeQuota?: (request: Request) => void | Response | Promise<void | Response>;
  language?: string | ((request: Request) => string | undefined | Promise<string | undefined>);
  responseHeaders?: HeadersInit;
}

function originAllowed(
  origin: string,
  request: Request,
  allowed?: TranscriptionHandlerOptions["allowedOrigins"]
): boolean {
  if (origin === "null") return false;
  try {
    if (new URL(origin).origin !== origin) return false;
  } catch {
    return false;
  }
  if (typeof allowed === "function") return allowed(origin);
  if (allowed) return allowed.includes(origin);
  return origin === new URL(request.url).origin;
}

function responseHeaders(
  options: TranscriptionHandlerOptions,
  request: Request,
  origin: string | null
): Headers {
  const headers = new Headers(options.responseHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.append("vary", "Origin");
  if (origin && originAllowed(origin, request, options.allowedOrigins)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function json(
  body: Record<string, unknown>,
  status: number,
  options: TranscriptionHandlerOptions,
  request: Request,
  origin: string | null
): Response {
  const headers = responseHeaders(options, request, origin);
  if (status === 405) headers.set("allow", "POST, OPTIONS");
  return new Response(JSON.stringify(body), {
    status,
    headers
  });
}

function preflightResponse(
  options: TranscriptionHandlerOptions,
  request: Request,
  origin: string
): Response {
  const headers = responseHeaders(options, request, origin);
  headers.delete("content-type");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    (options.allowedRequestHeaders ?? ["Content-Type", "Authorization"]).join(", ")
  );
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: 204, headers });
}

function hardenGateResponse(
  response: Response,
  options: TranscriptionHandlerOptions,
  request: Request,
  origin: string | null
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.append("vary", "Origin");
  if (origin && originAllowed(origin, request, options.allowedOrigins)) {
    headers.set("access-control-allow-origin", origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function publicError(error: unknown): TranscriptionServerError {
  if (error instanceof TranscriptionServerError) return error;
  return new TranscriptionServerError(
    "transcription-failed",
    "The transcription service could not complete the request.",
    502,
    { cause: error }
  );
}

export function createTranscriptionHandler(
  options: TranscriptionHandlerOptions
): (request: Request) => Promise<Response> {
  if (!options.provider?.transcribe) throw new TypeError("A transcription provider is required.");
  if (!options.authorize && options.allowUnauthenticated !== true) {
    throw new TypeError(
      "An authorize callback is required. Set allowUnauthenticated: true only for a deliberately public endpoint."
    );
  }
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_SERVER_MAX_DURATION_MS;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new TypeError("maxDurationMs must be a positive number.");
  }
  const durationInspector = options.inspectDurationMs ?? inspectAudioDurationMs;

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    try {
      if (request.method === "OPTIONS") {
        if (!origin || !originAllowed(origin, request, options.allowedOrigins)) {
          throw new TranscriptionServerError(
            "origin-not-allowed",
            "This request origin is not allowed.",
            403
          );
        }
        return preflightResponse(options, request, origin);
      }
      if (request.method !== "POST") {
        throw new TranscriptionServerError(
          "method-not-allowed",
          "Only POST requests are accepted.",
          405
        );
      }
      if (!origin && options.allowMissingOrigin !== true) {
        throw new TranscriptionServerError(
          "origin-not-allowed",
          "An Origin header is required for this endpoint.",
          403
        );
      }
      if (origin && !originAllowed(origin, request, options.allowedOrigins)) {
        throw new TranscriptionServerError(
          "origin-not-allowed",
          "This request origin is not allowed.",
          403
        );
      }

      const authorization = await options.authorize?.(request);
      if (authorization instanceof Response) {
        return hardenGateResponse(authorization, options, request, origin);
      }
      const quota = await options.consumeQuota?.(request);
      if (quota instanceof Response) {
        return hardenGateResponse(quota, options, request, origin);
      }

      const audio = await readBoundedBody(request, options.maxBytes ?? DEFAULT_SERVER_MAX_BYTES);
      const mimeType = validateAudioMime(
        audio,
        request.headers.get("content-type"),
        options.allowedMimeTypes
      );
      let durationMs: number;
      try {
        durationMs = await durationInspector(audio, mimeType);
      } catch (error) {
        if (error instanceof TranscriptionServerError) throw error;
        throw new TranscriptionServerError(
          "invalid-audio-duration",
          "The audio duration could not be verified.",
          415,
          { cause: error }
        );
      }
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new TranscriptionServerError(
          "invalid-audio-duration",
          "The audio duration could not be verified.",
          415
        );
      }
      if (durationMs > maxDurationMs) {
        throw new TranscriptionServerError(
          "audio-too-long",
          `Audio exceeds the ${maxDurationMs} ms duration limit.`,
          413
        );
      }
      const language =
        typeof options.language === "function"
          ? await options.language(request)
          : options.language;
      const result = await options.provider.transcribe({
        audio,
        mimeType,
        filename: `recording.${extensionForAudioMime(mimeType)}`,
        ...(language ? { language } : {}),
        signal: request.signal
      });
      const text = (typeof result === "string" ? result : result.text).trim();
      if (!text) {
        throw new TranscriptionServerError(
          "empty-transcript",
          "No speech was recognized in the recording.",
          422
        );
      }

      const metadata = typeof result === "string" ? null : result;
      const providerDurationMs = metadata?.durationMs ??
        (metadata?.durationSeconds !== undefined ? metadata.durationSeconds * 1_000 : undefined);
      return json(
        {
          text,
          ...(metadata?.language ? { language: metadata.language } : {}),
          durationMs:
            providerDurationMs !== undefined &&
            Number.isFinite(providerDurationMs) &&
            providerDurationMs > 0
              ? providerDurationMs
              : durationMs
        },
        200,
        options,
        request,
        origin
      );
    } catch (caught) {
      const error = publicError(caught);
      return json(
        { error: { code: error.code, message: error.message } },
        error.status,
        options,
        request,
        origin
      );
    }
  };
}
