import { describe, expect, it, vi } from "vitest";

const { parseBufferSpy } = vi.hoisted(() => ({ parseBufferSpy: vi.fn() }));

vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  parseBufferSpy.mockImplementation(actual.parseBuffer);
  return { ...actual, parseBuffer: parseBufferSpy };
});
import {
  TranscriptionServerError,
  createTranscriptionHandler,
  inspectAudioDurationMs,
  readBoundedBody,
  sniffAudioMime,
  validateAudioMime,
  type TranscriptionProvider
} from "./index";

const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);
const mp4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
function wavWithDuration(durationSeconds: number, sampleRate = 8_000): Uint8Array {
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

describe("bounded request bodies", () => {
  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("https://example.test/transcribe", {
      method: "POST",
      headers: { "content-length": "100" },
      body: webm
    });
    await expect(readBoundedBody(request, 10)).rejects.toMatchObject({
      code: "body-too-large",
      status: 413
    });
  });

  it("returns an exact byte copy", async () => {
    const request = new Request("https://example.test/transcribe", {
      method: "POST",
      body: webm
    });
    expect(await readBoundedBody(request, 100)).toEqual(webm);
  });
});

describe("audio signature validation", () => {
  it("detects common browser containers", () => {
    expect(sniffAudioMime(webm)).toBe("audio/webm");
    expect(sniffAudioMime(mp4)).toBe("audio/mp4");
  });

  it("requests a full metadata duration scan", async () => {
    parseBufferSpy.mockClear();
    const audio = wavWithDuration(1);
    await expect(inspectAudioDurationMs(audio, "audio/wav")).resolves.toBeCloseTo(1_000, -1);
    expect(parseBufferSpy).toHaveBeenCalledWith(
      audio,
      { mimeType: "audio/wav" },
      { duration: true }
    );
  });

  it("rejects a declared type that conflicts with the file", () => {
    expect(() => validateAudioMime(webm, "audio/mp4")).toThrowError(
      TranscriptionServerError
    );
    try {
      validateAudioMime(webm, "audio/mp4");
    } catch (error) {
      expect(error).toMatchObject({ code: "mime-mismatch", status: 415 });
    }
  });
});

describe("transcription handler", () => {
  it("validates audio and returns a private editable transcript", async () => {
    const transcribe = vi.fn(async () => ({ text: "  synthetic note  ", language: "en" }));
    const provider: TranscriptionProvider = { transcribe };
    const handler = createTranscriptionHandler({
      provider,
      maxBytes: 100,
      allowUnauthenticated: true,
      inspectDurationMs: async () => 1_000,
      allowedOrigins: ["https://app.example.test"],
      language: "en"
    });
    const response = await handler(
      new Request("https://api.example.test/transcribe", {
        method: "POST",
        headers: {
          "content-type": "audio/webm;codecs=opus",
          origin: "https://app.example.test"
        },
        body: webm
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.test"
    );
    expect(await response.json()).toEqual({ text: "synthetic note", language: "en" });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: webm,
        mimeType: "audio/webm",
        filename: "recording.webm",
        language: "en"
      })
    );
  });

  it("rejects an untrusted origin before calling the provider", async () => {
    const transcribe = vi.fn(async () => "never called");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      allowUnauthenticated: true,
      allowedOrigins: ["https://app.example.test"]
    });
    const response = await handler(
      new Request("https://api.example.test/transcribe", {
        method: "POST",
        headers: { origin: "https://other.example.test", "content-type": "audio/webm" },
        body: webm
      })
    );
    expect(response.status).toBe(403);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("answers trusted cross-origin preflight requests", async () => {
    const transcribe = vi.fn(async () => "unused");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      allowUnauthenticated: true,
      allowedOrigins: ["https://app.example.test"]
    });
    const response = await handler(
      new Request("https://api.example.test/transcribe", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.test" }
      })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.test"
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("does not expose upstream errors", async () => {
    const handler = createTranscriptionHandler({
      allowUnauthenticated: true,
      inspectDurationMs: async () => 1_000,
      provider: {
        transcribe: async () => {
          throw new Error("sensitive upstream detail");
        }
      }
    });
    const response = await handler(
      new Request("https://api.example.test/transcribe", {
        method: "POST",
        headers: {
          origin: "https://api.example.test",
          "content-type": "audio/webm"
        },
        body: webm
      })
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("sensitive upstream detail");
  });

  it("fails closed when authentication was not explicitly configured", () => {
    expect(() =>
      createTranscriptionHandler({ provider: { transcribe: async () => "unused" } })
    ).toThrow(/authorize callback is required/i);
  });

  it("allows same-origin requests by default and rejects cross-origin requests", async () => {
    const transcribe = vi.fn(async () => "same origin");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      allowUnauthenticated: true,
      inspectDurationMs: async () => 1_000
    });
    const sameOrigin = await handler(
      new Request("https://app.example.test/api/transcribe", {
        method: "POST",
        headers: { origin: "https://app.example.test", "content-type": "audio/webm" },
        body: webm
      })
    );
    const crossOrigin = await handler(
      new Request("https://app.example.test/api/transcribe", {
        method: "POST",
        headers: { origin: "https://attacker.example", "content-type": "audio/webm" },
        body: webm
      })
    );
    expect(sameOrigin.status).toBe(200);
    expect(crossOrigin.status).toBe(403);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("runs authorization and quota gates before reading or transcribing audio", async () => {
    const consumeQuota = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "rate-limited" } }), { status: 429 })
    );
    const transcribe = vi.fn(async () => "never");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      authorize: async () => undefined,
      consumeQuota,
      inspectDurationMs: async () => 1_000
    });
    const response = await handler(
      new Request("https://app.example.test/api/transcribe", {
        method: "POST",
        headers: { origin: "https://app.example.test" }
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(consumeQuota).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects real audio longer than the configured limit before provider use", async () => {
    const transcribe = vi.fn(async () => "never");
    const audio = wavWithDuration(2);
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      allowUnauthenticated: true,
      maxDurationMs: 1_000,
      maxBytes: audio.byteLength + 1
    });
    const response = await handler(
      new Request("https://app.example.test/api/transcribe", {
        method: "POST",
        headers: {
          origin: "https://app.example.test",
          "content-type": "audio/wav"
        },
        body: audio.slice().buffer as ArrayBuffer
      })
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "audio-too-long" } });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects missing Origin by default even when anonymous access was deliberate", async () => {
    const transcribe = vi.fn(async () => "never");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      allowUnauthenticated: true,
      inspectDurationMs: async () => 1_000
    });
    const response = await handler(
      new Request("https://app.example.test/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: webm
      })
    );
    expect(response.status).toBe(403);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
