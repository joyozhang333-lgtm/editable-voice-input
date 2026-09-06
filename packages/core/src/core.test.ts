import { describe, expect, it, vi } from "vitest";
import {
  BrowserVoiceCapture,
  ObjectUrlLease,
  baseMimeType,
  chooseRecordingMimeType,
  extensionForMimeType,
  mergeTranscriptDraft,
  transcriptionText
} from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const dataEvent = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(dataEvent, "data", {
      value: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType })
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

class AsyncStopMediaRecorder extends EventTarget {
  static latest: AsyncStopMediaRecorder | null = null;

  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";
  readonly stop = vi.fn(() => {
    this.state = "inactive";
  });

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    AsyncStopMediaRecorder.latest = this;
  }

  start(): void {
    this.state = "recording";
  }

  flushFinalEvents(): void {
    const dataEvent = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(dataEvent, "data", {
      value: new Blob([new Uint8Array([4, 5, 6, 7])], { type: this.mimeType })
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

class FakeTrack extends EventTarget {
  readonly stop = vi.fn();
}

describe("MIME negotiation", () => {
  it("selects the first supported browser recording format", () => {
    const isTypeSupported = vi.fn((type: string) => type === "audio/mp4");
    expect(chooseRecordingMimeType({ isTypeSupported })).toBe("audio/mp4");
    expect(isTypeSupported).toHaveBeenCalledWith("audio/webm;codecs=opus");
  });

  it("normalizes MIME parameters and file extensions", () => {
    expect(baseMimeType(" Audio/WebM; codecs=opus ")).toBe("audio/webm");
    expect(extensionForMimeType("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(extensionForMimeType("application/octet-stream")).toBe("audio");
  });
});

describe("editable draft merging", () => {
  it("preserves the existing draft and appends a transcript", () => {
    expect(mergeTranscriptDraft("Existing thought", "  spoken detail  ")).toBe(
      "Existing thought\nspoken detail"
    );
  });

  it("can deliberately replace a draft", () => {
    expect(mergeTranscriptDraft("old", " new ", { strategy: "replace" })).toBe("new");
    expect(mergeTranscriptDraft("old", "   ")).toBe("old");
  });

  it("reads both provider result shapes", () => {
    expect(transcriptionText("hello")).toBe("hello");
    expect(transcriptionText({ text: "hello" })).toBe("hello");
  });
});

describe("ObjectUrlLease", () => {
  it("revokes old and final object URLs", () => {
    const createObjectURL = vi
      .fn<(blob: Blob) => string>()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.fn();
    const lease = new ObjectUrlLease({ createObjectURL, revokeObjectURL });

    expect(lease.replace(new Blob(["a"]))).toBe("blob:first");
    expect(lease.replace(new Blob(["b"]))).toBe("blob:second");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
    lease.revoke();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
    expect(lease.value).toBeNull();
  });
});

describe("BrowserVoiceCapture", () => {
  it("waits for final dataavailable when stop is requested more than once", async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const capture = new BrowserVoiceCapture({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      MediaRecorderConstructor: AsyncStopMediaRecorder as unknown as typeof MediaRecorder
    });

    const session = await capture.start();
    const firstStop = session.stop();
    const secondStop = session.stop();
    let completed = false;
    void firstStop.then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(firstStop).toBe(secondStop);
    expect(AsyncStopMediaRecorder.latest!.stop).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(session.active).toBe(true);
    await expect(capture.start()).rejects.toMatchObject({ code: "recording-failed" });

    AsyncStopMediaRecorder.latest!.flushFinalEvents();
    await expect(firstStop).resolves.toMatchObject({ size: 4 });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("returns an in-memory Blob and releases microphone tracks", async () => {
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }]
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    let now = 1_000;
    const capture = new BrowserVoiceCapture({
      mediaDevices: { getUserMedia },
      MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder,
      now: () => now
    });

    const session = await capture.start();
    now = 1_850;
    const result = await session.stop();

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.any(Object), video: false })
    );
    expect(result).toMatchObject({
      mimeType: "audio/webm;codecs=opus",
      durationMs: 850,
      size: 3,
      terminationReason: "user-stop"
    });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("marks an automatic duration limit separately from a user stop", async () => {
    vi.useFakeTimers();
    try {
      const track = new FakeTrack();
      const capture = new BrowserVoiceCapture({
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] } as unknown as MediaStream))
        },
        MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder,
        maxDurationMs: 50
      });
      const session = await capture.start();
      await vi.advanceTimersByTimeAsync(50);
      await expect(session.result).resolves.toMatchObject({
        terminationReason: "max-duration"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects overlapping starts while microphone permission is pending", async () => {
    const permission = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => permission.promise);
    const capture = new BrowserVoiceCapture({
      mediaDevices: { getUserMedia },
      MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder
    });

    const firstStart = capture.start();
    await expect(capture.start()).rejects.toMatchObject({ code: "recording-failed" });

    const stopTrack = vi.fn();
    permission.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    const session = await firstStart;
    session.cancel();
    await expect(session.result).rejects.toMatchObject({ code: "capture-cancelled" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("releases a stream that arrives after pending permission was cancelled", async () => {
    const permission = deferred<MediaStream>();
    const stopTrack = vi.fn();
    const capture = new BrowserVoiceCapture({
      mediaDevices: { getUserMedia: vi.fn(() => permission.promise) },
      MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder
    });

    const start = capture.start();
    capture.cancel();
    permission.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);

    await expect(start).rejects.toMatchObject({ code: "capture-cancelled" });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it.each(["pagehide", "hidden"] as const)(
    "cancels pending microphone permission when the page exits through %s",
    async (exit) => {
      const permission = deferred<MediaStream>();
      const track = new FakeTrack();
      const pageLifecycleTarget = new EventTarget();
      const visibilityTarget = new EventTarget() as EventTarget & {
        visibilityState: DocumentVisibilityState;
      };
      visibilityTarget.visibilityState = "visible";
      const capture = new BrowserVoiceCapture({
        mediaDevices: { getUserMedia: vi.fn(() => permission.promise) },
        MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder,
        pageLifecycleTarget,
        visibilityDocument: visibilityTarget
      });

      const start = capture.start();
      if (exit === "pagehide") pageLifecycleTarget.dispatchEvent(new Event("pagehide"));
      else {
        visibilityTarget.visibilityState = "hidden";
        visibilityTarget.dispatchEvent(new Event("visibilitychange"));
      }
      permission.resolve({ getTracks: () => [track] } as unknown as MediaStream);

      await expect(start).rejects.toMatchObject({ code: "capture-cancelled" });
      expect(track.stop).toHaveBeenCalledOnce();
    }
  );

  it("remains reusable after an unsupported start attempt", async () => {
    const capture = new BrowserVoiceCapture();
    await expect(capture.start()).rejects.toMatchObject({ code: "unsupported-browser" });
    await expect(capture.start()).rejects.toMatchObject({ code: "unsupported-browser" });
  });

  it.each(["track-ended", "pagehide", "hidden"] as const)(
    "safely stops and releases audio on %s lifecycle exit",
    async (exit) => {
      const track = new FakeTrack();
      const pageLifecycleTarget = new EventTarget();
      const visibilityTarget = new EventTarget() as EventTarget & {
        visibilityState: DocumentVisibilityState;
      };
      visibilityTarget.visibilityState = "visible";
      const stream = { getTracks: () => [track] } as unknown as MediaStream;
      const capture = new BrowserVoiceCapture({
        mediaDevices: { getUserMedia: vi.fn(async () => stream) },
        MediaRecorderConstructor: FakeMediaRecorder as unknown as typeof MediaRecorder,
        pageLifecycleTarget,
        visibilityDocument: visibilityTarget
      });
      const session = await capture.start();

      if (exit === "track-ended") track.dispatchEvent(new Event("ended"));
      if (exit === "pagehide") pageLifecycleTarget.dispatchEvent(new Event("pagehide"));
      if (exit === "hidden") {
        visibilityTarget.visibilityState = "hidden";
        visibilityTarget.dispatchEvent(new Event("visibilitychange"));
      }

      await expect(session.result).resolves.toMatchObject({ size: 3 });
      await expect(session.result).resolves.toMatchObject({
        terminationReason: exit === "track-ended" ? "track-ended" : "page-hidden"
      });
      expect(track.stop).toHaveBeenCalledOnce();
    }
  );
});
