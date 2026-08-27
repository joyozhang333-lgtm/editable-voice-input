// @vitest-environment jsdom

import type { CapturedAudio, VoiceCaptureSession } from "@editable-voice-input/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableVoiceInput, type VoiceCaptureController } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("EditableVoiceInput", () => {
  it("creates an editable draft without auto-submitting", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:synthetic-recording")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const completion = deferred<CapturedAudio>();
    const audio = {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      mimeType: "audio/webm",
      durationMs: 900,
      size: 3
    };
    const session: VoiceCaptureSession = {
      active: true,
      result: completion.promise,
      stop: vi.fn(async () => {
        completion.resolve(audio);
        return completion.promise;
      }),
      cancel: vi.fn()
    };
    const capture: VoiceCaptureController = {
      start: vi.fn(async () => session),
      cancel: vi.fn(),
      dispose: vi.fn()
    };
    const transcribe = vi.fn(async () => ({ text: "a spoken draft" }));
    const onSubmit = vi.fn();

    render(
      <EditableVoiceInput
        defaultValue="typed first"
        capture={capture}
        transcribe={transcribe}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "typed first\na spoken draft"
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "edited before submit" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ text: "edited before submit", audio });
    });
  });

  it("locks duplicate submissions while one is in flight", async () => {
    const submission = deferred<void>();
    const onSubmit = vi.fn(() => submission.promise);
    render(
      <EditableVoiceInput
        defaultValue="send once"
        capture={{ start: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }}
        transcribe={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledOnce();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Submitting…");

    submission.resolve();
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  });

  it("turns submit failures into controlled error state", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("private integration detail");
    });
    render(
      <EditableVoiceInput
        defaultValue="safe draft"
        capture={{ start: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }}
        transcribe={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Voice submission failed.");
    });
    expect(screen.getByRole("region", { name: "Message" }).getAttribute("data-state")).toBe(
      "error"
    );
    expect(screen.queryByText("private integration detail")).toBeNull();
  });
});
