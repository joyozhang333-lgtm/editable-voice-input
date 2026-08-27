import { TranscriptionServerError } from "./types";

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new TranscriptionServerError(
        "body-too-large",
        `Audio exceeds the ${maxBytes} byte limit.`,
        413
      );
    }
  }

  if (!request.body) {
    throw new TranscriptionServerError("body-required", "An audio request body is required.", 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body-too-large");
        throw new TranscriptionServerError(
          "body-too-large",
          `Audio exceeds the ${maxBytes} byte limit.`,
          413
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (!total) {
    throw new TranscriptionServerError("body-required", "An audio request body is required.", 400);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
