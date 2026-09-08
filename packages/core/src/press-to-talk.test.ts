import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserVoiceCapture, PressToTalkController, VoiceInputError,
  type CapturedAudio, type PressToTalkOptions, type VoiceCaptureSession
} from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const audio = (terminationReason: CapturedAudio["terminationReason"] = "user-stop"): CapturedAudio => {
  const blob = new Blob(["synthetic audio"], { type: "audio/webm" });
  return { blob, size: blob.size, durationMs: 1000, mimeType: blob.type,
    ...(terminationReason ? { terminationReason } : {}) };
};
const point = (clientY = 300, pointerId = 1) => ({ pointerId, clientY });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const controllers: PressToTalkController[] = [];
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); vi.useRealTimers(); });

function setup(options: Partial<PressToTalkOptions> = {}) {
  const result = deferred<CapturedAudio>();
  const session: VoiceCaptureSession = {
    result: result.promise, active: true,
    stop: vi.fn(() => result.promise),
    cancel: vi.fn(() => result.reject(new VoiceInputError("capture-cancelled", "Cancelled")))
  };
  const capture = { start: vi.fn(async () => session), cancel: vi.fn(), dispose: vi.fn() };
  const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(async () => undefined);
  const controller = new PressToTalkController({ sessionKey: "session-a", onCommit, capture, ...options });
  controllers.push(controller);
  return { controller, result, session, capture, onCommit };
}

describe("PressToTalk explicit commit", () => {
  it("commits exactly once only after final audio on release", async () => {
    const { controller: c, onCommit, result, session } = setup();
    expect(c.pointerDown(point())).toBe(true);
    expect(c.getSnapshot().phase).toBe("requesting-permission");
    await flush();
    expect(onCommit).not.toHaveBeenCalled();
    c.pointerUp(point());
    c.pointerUp(point());
    c.stop();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    result.resolve(audio());
    await flush();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      intent: "send", source: "pointer", sessionKey: "session-a",
      recordingId: expect.any(String), audio: expect.objectContaining({ size: 15 })
    }));
    expect(c.getSnapshot().phase).toBe("idle");
  });

  it("offers an activation start and explicit stop without a held pointer/key", async () => {
    const { controller: c, result, onCommit } = setup();
    await c.start();
    c.stop();
    result.resolve(audio());
    await flush();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ intent: "send", source: "activation" }));
  });

  it.each(["max-duration", "track-ended", "page-hidden"] as const)(
    "does not commit automatic %s termination even if release races", async (reason) => {
      const { controller: c, result, onCommit } = setup();
      await c.start();
      c.stop();
      result.resolve(audio(reason));
      await flush();
      expect(onCommit).not.toHaveBeenCalled();
      expect(c.getSnapshot().phase).toBe("idle");
    }
  );

  it("requires an explicit stop even for a custom capture with no termination reason", async () => {
    const { controller: c, result, onCommit } = setup();
    await c.start();
    const recorded = audio();
    delete recorded.terminationReason;
    result.resolve(recorded);
    await flush();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["slide", "pointercancel", "cancel", "session", "mode", "dispose"])(
    "does not commit after %s", async (action) => {
      const { controller: c, result, onCommit } = setup();
      c.pointerDown(point());
      await flush();
      if (action === "slide") c.pointerUp(point(200));
      if (action === "pointercancel") c.pointerCancel(1);
      if (action === "cancel") c.cancel();
      if (action === "session") c.setSession("session-b");
      if (action === "mode") c.setMode("dictate");
      if (action === "dispose") c.dispose();
      c.pointerUp(point());
      result.resolve(audio());
      await flush();
      expect(onCommit).not.toHaveBeenCalled();
    }
  );

  it("only tracks the initiating primary pointer and allows sliding back", async () => {
    const { controller: c, result, onCommit } = setup();
    expect(c.pointerDown({ ...point(), isPrimary: false })).toBe(false);
    expect(c.pointerDown({ ...point(), button: 2 })).toBe(false);
    expect(c.pointerDown(point(NaN))).toBe(false);
    c.pointerDown(point());
    expect(c.pointerDown(point(200, 2))).toBe(false);
    await flush();
    c.pointerMove(point(220, 2));
    c.pointerCancel(2);
    c.pointerUp(point(300, 2));
    expect(c.getSnapshot().phase).toBe("recording");
    c.pointerMove(point(236));
    expect(c.getSnapshot().cancelPending).toBe(true);
    c.pointerMove(point(250));
    expect(c.getSnapshot().cancelPending).toBe(false);
    c.pointerUp(point(250));
    result.resolve(audio());
    await flush();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid final coordinates", async () => {
    const { controller: c, onCommit } = setup();
    c.pointerDown(point());
    await flush();
    c.pointerUp(point(NaN));
    await flush();
    expect(c.getSnapshot().phase).toBe("idle");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("never replays release after permission arrives and does not overlap starts", async () => {
    const { controller: c, capture, session, onCommit } = setup();
    const permission = deferred<VoiceCaptureSession>();
    capture.start.mockReturnValueOnce(permission.promise);
    c.pointerDown(point());
    await c.start();
    expect(capture.start).toHaveBeenCalledOnce();
    c.pointerUp(point());
    permission.resolve(session);
    await flush();
    expect(session.cancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe("idle");
  });

  it("cleans up actual BrowserVoiceCapture permission granted after release", async () => {
    const permission = deferred<MediaStream>();
    const stop = vi.fn();
    const capture = new BrowserVoiceCapture({
      mediaDevices: { getUserMedia: () => permission.promise },
      MediaRecorderConstructor: class {} as unknown as typeof MediaRecorder
    });
    const { controller: c, onCommit } = setup({ capture });
    c.pointerDown(point());
    c.pointerUp(point());
    permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("PressToTalk draft and scope fences", () => {
  it.each(["untouched", "edited", "edit-and-restore"])(
    "handles %s drafts without sending", async (editing) => {
      const transcription = deferred<{ text: string }>();
      const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(() => transcription.promise);
      const { controller: c, result } = setup({ onCommit, defaultText: "Original" });
      await c.start({ intent: "dictate" });
      if (editing !== "untouched") c.setText("Edited");
      if (editing === "edit-and-restore") c.setText("Original");
      c.stop();
      result.resolve(audio());
      await flush();
      expect(c.getSnapshot().phase).toBe("transcribing");
      transcription.resolve({ text: "Synthetic transcript" });
      await flush();
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ intent: "dictate" }));
      expect(c.getSnapshot().text).toBe(editing === "untouched"
        ? "Original\nSynthetic transcript" : editing === "edited" ? "Edited" : "Original");
      expect(c.getSnapshot().transcriptSuggestion).toBe(editing === "untouched" ? null : "Synthetic transcript");
    }
  );

  it("converts an active send take to dictate, without release later sending it", async () => {
    const { controller: c, result, onCommit } = setup();
    onCommit.mockResolvedValue("Synthetic transcript");
    c.pointerDown(point());
    await flush();
    c.stopToDictate();
    c.pointerUp(point());
    result.resolve(audio());
    await flush();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ intent: "dictate" }));
    expect(c.getSnapshot().text).toBe("Synthetic transcript");
  });

  it("does not convert a pending permission request into a late commit", async () => {
    const { controller: c, onCommit } = setup();
    c.pointerDown(point());
    c.stopToDictate();
    await flush();
    expect(c.getSnapshot().mode).toBe("dictate");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["session", "same-session", "cancel", "mode", "new-take", "dispose"])(
    "rejects late transcription after %s even when the host ignores abort", async (action) => {
      const transcription = deferred<string>();
      const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(() => transcription.promise);
      const { controller: c, result } = setup({ onCommit, defaultText: "Original" });
      await c.start({ intent: "dictate" });
      c.stop();
      result.resolve(audio());
      await flush();
      const signal = onCommit.mock.calls[0]![0]?.signal;
      if (action === "session") c.setSession("session-b", "New draft");
      if (action === "same-session") c.setSession("session-a", "New draft");
      if (action === "cancel") c.cancel();
      if (action === "mode") c.setMode("send");
      if (action === "new-take") await c.start({ intent: "dictate" });
      if (action === "dispose") c.dispose();
      transcription.resolve("Late transcript");
      await flush();
      expect(signal?.aborted).toBe(true);
      expect(c.getSnapshot().text).not.toContain("Late");
      expect(c.getSnapshot().transcriptSuggestion).toBeNull();
    }
  );

  it("ignores send return text and exposes immutable scope and cancellation to the host", async () => {
    const commit = deferred<string>();
    const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(() => commit.promise);
    const { controller: c, result } = setup({ onCommit, defaultText: "Draft" });
    await c.start();
    c.stop();
    result.resolve(audio());
    await flush();
    const input = onCommit.mock.calls[0]![0];
    c.setSession("session-b", "Another draft");
    commit.resolve("Never insert send copy");
    await flush();
    expect(input.sessionKey).toBe("session-a");
    expect(input.signal.aborted).toBe(true);
    expect(c.getSnapshot().text).toBe("Another draft");
  });

  it("does not insert send text even in the unchanged session", async () => {
    const { controller: c, result, onCommit } = setup({ defaultText: "Draft" });
    onCommit.mockResolvedValue("Send copy");
    await c.start(); c.stop(); result.resolve(audio()); await flush();
    expect(c.getSnapshot().text).toBe("Draft");
  });
});

describe("PressToTalk lifecycle and failures", () => {
  it.each(["pending", "recording", "stopping", "transcribing", "committing"])(
    "invalidates %s work when the page hides", async (phase) => {
      const lifecycle = new EventTarget();
      const document = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
      const callback = deferred<string>();
      const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(() => callback.promise);
      const { controller: c, result } = setup({ onCommit,
        captureOptions: { pageLifecycleTarget: lifecycle, visibilityDocument: document } });
      const start = c.start({ intent: phase === "transcribing" ? "dictate" : "send" });
      if (phase !== "pending") await start;
      if (["stopping", "transcribing", "committing"].includes(phase)) c.stop();
      if (["transcribing", "committing"].includes(phase)) { result.resolve(audio()); await flush(); }
      const signal = onCommit.mock.calls[0]?.[0].signal;
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      lifecycle.dispatchEvent(new Event("pagehide"));
      callback.resolve("Late text");
      result.resolve(audio());
      await start; await flush();
      expect(c.getSnapshot().phase).toBe("idle");
      expect(c.getSnapshot().text).toBe("");
      if (signal) expect(signal.aborted).toBe(true);
      else expect(onCommit).not.toHaveBeenCalled();
    }
  );

  it("does not request permission from a hidden page", async () => {
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" as const });
    const { controller: c, capture } = setup({ captureOptions: { visibilityDocument: document } });
    await c.start();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("cancels pending work on pagehide without visibilitychange", async () => {
    const lifecycle = new EventTarget();
    const { controller: c, onCommit } = setup({ captureOptions: { pageLifecycleTarget: lifecycle } });
    c.pointerDown(point());
    lifecycle.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(c.getSnapshot().phase).toBe("idle");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["permission", "capture", "stop-throw", "stop-reject", "commit", "empty", "invalid-transcript"])(
    "reports %s failure without retrying a send", async (failure) => {
      const { controller: c, capture, session, result, onCommit } = setup();
      if (failure === "permission") capture.start.mockRejectedValueOnce(new VoiceInputError("permission-denied", "Denied"));
      if (failure === "stop-throw") vi.mocked(session.stop).mockImplementation(() => { throw new Error("stop"); });
      if (failure === "stop-reject") vi.mocked(session.stop).mockRejectedValue(new Error("stop"));
      if (failure === "commit") onCommit.mockRejectedValueOnce(new Error("host"));
      if (failure === "invalid-transcript") onCommit.mockResolvedValue({ text: 42 } as never);
      await c.start({ intent: failure === "invalid-transcript" ? "dictate" : "send" });
      c.stop();
      if (failure === "capture") result.reject(new Error("recorder"));
      else result.resolve(failure === "empty" ? { ...audio(), blob: new Blob() } : audio());
      await flush();
      expect(c.getSnapshot().phase).toBe("error");
      c.stop();
      expect(onCommit.mock.calls.length).toBeLessThanOrEqual(1);
    }
  );

  it("has stable snapshots, isolated subscriber errors, a timer, and terminal disposal", async () => {
    vi.useFakeTimers();
    const { controller: c, capture } = setup();
    const listener = vi.fn();
    const unsubscribe = c.subscribe(listener);
    c.subscribe(() => { throw new Error("host renderer"); });
    expect(c.getSnapshot()).toBe(c.getSnapshot());
    expect(Object.isFrozen(c.getSnapshot())).toBe(true);
    await c.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(c.getSnapshot().elapsedMs).toBe(500);
    unsubscribe();
    listener.mockClear();
    c.cancel(); c.dispose(); c.dispose();
    c.setText("ignored"); c.setSession("ignored"); c.setMode("dictate"); c.stopToDictate();
    await c.start();
    expect(capture.start).toHaveBeenCalledOnce();
    expect(capture.dispose).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks cancellation triggered synchronously by a subscriber before handoff", async () => {
    const { controller: c, result, onCommit } = setup();
    c.subscribe(() => { if (c.getSnapshot().phase === "committing") c.cancel(); });
    await c.start(); c.stop(); result.resolve(audio()); await flush();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects invalid gesture thresholds", () => {
    for (const cancelDistancePx of [0, -1, Infinity, NaN]) {
      expect(() => setup({ cancelDistancePx })).toThrow(RangeError);
    }
  });
});
