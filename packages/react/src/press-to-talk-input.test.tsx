// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PressToTalkController, type CapturedAudio, type PressToTalkOptions } from "@editable-voice-input/core";
import { PressToTalkInput } from "./press-to-talk-input";

afterEach(cleanup);
function setup() {
  let resolve!: (audio: CapturedAudio) => void;
  const result = new Promise<CapturedAudio>((yes) => { resolve = yes; });
  const capture = { start: vi.fn(async () => ({ active: true, result, stop: () => result, cancel() {} })), cancel: vi.fn(), dispose: vi.fn() };
  const onCommit = vi.fn<PressToTalkOptions["onCommit"]>(async () => ({ text: "Synthetic transcript" }));
  const controller = new PressToTalkController({ sessionKey: "synthetic-session", capture, onCommit });
  const onSubmitText = vi.fn();
  const view = render(<StrictMode><PressToTalkInput controller={controller} onSubmitText={onSubmitText} /></StrictMode>);
  const finish = async () => {
    const blob = new Blob(["synthetic"]);
    await act(async () => resolve({ blob, size: blob.size, durationMs: 1000, mimeType: "audio/webm" }));
  };
  return { controller, onCommit, onSubmitText, capture, finish, ...view };
}

describe("PressToTalkInput", () => {
  it("shows one recording area and one mode switch, not tabs", () => {
    const { controller } = setup();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Hold to talk/ }).textContent).toContain("release to send");
    controller.dispose();
  });

  it("dictates through a clickable mic and only sends text on explicit action", async () => {
    const { controller, onCommit, onSubmitText, finish } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate text" })));
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await finish();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ intent: "dictate" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Synthetic transcript");
    expect(onSubmitText).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited text" } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    expect(onSubmitText).toHaveBeenCalledExactlyOnceWith({ text: "Edited text", sessionKey: "synthetic-session" });
    controller.dispose();
  });

  it("retains an edited draft and shows a late transcript as a suggestion", async () => {
    const { controller, finish } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate text" })));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await finish();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("My draft");
    expect(screen.getByText("Synthetic transcript")).toBeTruthy();
    controller.dispose();
  });

  it("converts the same active take to editable text and never sends its audio", async () => {
    const { controller, onCommit, finish } = setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Hold to talk/ }), { detail: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    await finish();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ intent: "dictate" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Synthetic transcript");
    controller.dispose();
  });

  it("cancels through Escape, the cancel button and unmount", async () => {
    const { controller, capture, onCommit, unmount, finish } = setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Hold to talk/ }), { detail: 0 }));
    fireEvent.keyDown(screen.getByRole("button", { name: /Release to send/ }), { key: "Escape" });
    expect(controller.getSnapshot().phase).toBe("idle");
    await act(async () => controller.start());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => controller.start());
    unmount();
    await finish();
    expect(capture.cancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });
});
