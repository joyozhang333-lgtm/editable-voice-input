import { Buffer } from "node:buffer";
import { parseBuffer } from "music-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionHandler,
  inspectAudioDurationMs,
  validateAudioMime,
  type AudioDurationInspector
} from "./index";

// Synthetic silence, not microphone data: Chromium 153.0.8010.12 MediaRecorder,
// AudioContext -> oscillator -> zero gain -> MediaStreamDestination, start(100),
// stop after 400 ms, concatenate all four chunks. decodeAudioData verified 0.36 s.
// These complete live WebM bytes omit Info.Duration; no metadata was removed.
const durationlessWebm = new Uint8Array(Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21lFlSua7+uvdeBAXPFh2jEVL5RhKiDgQKGhkFfT1BVU2Oik09wdXNIZWFkAQIAAIC7AAAAAADhjbWERzuAAJ+BAmJkgSAfQ7Z1Af/////////ngQCjjIEAAID/A//+//7//qOMgQA8gP8D//7//v/+H0O2dQH/////////54F1o4yBAACA/wP//v/+//6jjIEAPID/A//+//7//h9DtnUB/////////+eB76OMgQAAgP8D//7//v/+o4yBADyA/wP//v/+//4=",
  "base64"
));

function request(): Request {
  return new Request("https://example.test/transcribe", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "content-type": "audio/webm;codecs=opus"
    },
    body: durationlessWebm.slice().buffer as ArrayBuffer
  });
}

describe("durationless live WebM", () => {
  it("has a real Opus track but no metadata duration even with duration: true", async () => {
    expect(validateAudioMime(durationlessWebm, "audio/webm;codecs=opus")).toBe("audio/webm");
    const metadata = await parseBuffer(durationlessWebm, { mimeType: "audio/webm" }, { duration: true });
    expect(metadata.format).toMatchObject({ container: "EBML/webm", codec: "OPUS", sampleRate: 48_000 });
    expect(metadata.format.duration).toBeUndefined();
    await expect(inspectAudioDurationMs(durationlessWebm, "audio/webm")).rejects.toMatchObject({
      code: "invalid-audio-duration", status: 415
    });
  });

  it("fails closed with 415 before the provider when using the default inspector", async () => {
    const transcribe = vi.fn(async () => "not called");
    const handler = createTranscriptionHandler({
      provider: { transcribe },
      authorize: () => undefined
    });
    const response = await handler(request());
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "invalid-audio-duration" } });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("passes full bytes and normalized MIME to the injected inspector", async () => {
    // Interface stub only: this is deliberately not a decoder implementation.
    const inspectDurationMs = vi.fn<AudioDurationInspector>(async () => 360);
    const transcribe = vi.fn(async () => "synthetic transcript");
    const handler = createTranscriptionHandler({
      provider: { transcribe }, authorize: () => undefined, inspectDurationMs
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ durationMs: 360 });
    expect(inspectDurationMs).toHaveBeenCalledExactlyOnceWith(durationlessWebm, "audio/webm");
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      audio: durationlessWebm, mimeType: "audio/webm"
    }));
  });

  it.each([
    [0, 415, "invalid-audio-duration"],
    [-1, 415, "invalid-audio-duration"],
    [Number.NaN, 415, "invalid-audio-duration"],
    [Number.POSITIVE_INFINITY, 415, "invalid-audio-duration"],
    [120_001, 413, "audio-too-long"]
  ])("rejects injected duration %s before provider use", async (duration, status, code) => {
    const transcribe = vi.fn(async () => "not called");
    const handler = createTranscriptionHandler({
      provider: { transcribe }, authorize: () => undefined,
      inspectDurationMs: async () => duration as number
    });
    const response = await handler(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("fails closed without exposing a host inspector rejection", async () => {
    const transcribe = vi.fn(async () => "not called");
    const handler = createTranscriptionHandler({
      provider: { transcribe }, authorize: () => undefined,
      inspectDurationMs: async () => { throw new Error("private decoder detail"); }
    });
    const response = await handler(request());
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: {
      code: "invalid-audio-duration", message: "The audio duration could not be verified."
    } });
    expect(transcribe).not.toHaveBeenCalled();
  });
});
