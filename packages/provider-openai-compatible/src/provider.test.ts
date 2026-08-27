import type { ProviderTranscriptionInput } from "@editable-voice-input/server";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./index";

const input: ProviderTranscriptionInput = {
  audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
  mimeType: "audio/webm",
  filename: "recording.webm",
  language: "en"
};

describe("OpenAI-compatible provider", () => {
  it("sends multipart audio without setting a broken content-type boundary", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-placeholder");
      expect(headers.has("content-type")).toBe(false);
      expect(init?.redirect).toBe("error");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("language")).toBe("en");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe("recording.webm");
      return new Response(JSON.stringify({ text: "synthetic transcript", language: "en" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const provider = createOpenAICompatibleProvider({
      apiKey: "test-placeholder",
      fetch: fetchMock
    });

    await expect(provider.transcribe(input)).resolves.toEqual({
      text: "synthetic transcript",
      language: "en"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("supports a local compatible endpoint and plain-text responses", async () => {
    const fetchMock = vi.fn(async () => new Response("local transcript", { status: 200 }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:8080/",
      path: "/inference",
      fetch: fetchMock
    });
    await expect(provider.transcribe(input)).resolves.toEqual({ text: "local transcript" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/inference",
      expect.any(Object)
    );
  });

  it("does not include an upstream response body in errors", async () => {
    const fetchMock = vi.fn(
      async () => new Response("provider private detail", { status: 429 })
    );
    const provider = createOpenAICompatibleProvider({ fetch: fetchMock });
    await expect(provider.transcribe(input)).rejects.not.toThrow("provider private detail");
  });

  it("rejects plaintext remote endpoints and URL credentials", () => {
    expect(() =>
      createOpenAICompatibleProvider({ baseUrl: "http://api.example.test/v1" })
    ).toThrow(/HTTPS/i);
    expect(() =>
      createOpenAICompatibleProvider({ baseUrl: "https://user:secret@api.example.test/v1" })
    ).toThrow(/credentials/i);
  });

  it("rejects oversized provider responses before parsing them", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("not returned", {
          status: 200,
          headers: { "content-length": "1000" }
        })
    );
    const provider = createOpenAICompatibleProvider({
      fetch: fetchMock,
      maxResponseBytes: 100
    });
    await expect(provider.transcribe(input)).rejects.toThrow(/too large/i);
  });

  it("allows IPv6 loopback HTTP endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response('{"text":"local"}'));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "http://[::1]:8080",
      path: "/inference",
      fetch: fetchMock
    });
    await expect(provider.transcribe(input)).resolves.toEqual({ text: "local" });
  });
});
