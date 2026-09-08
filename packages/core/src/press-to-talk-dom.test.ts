// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPressToTalk, PressToTalkController, type CapturedAudio } from "./index";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const button = document.createElement("button");
  document.body.append(button);
  let captured: number | null = null;
  button.setPointerCapture = vi.fn((id) => { captured = id; });
  button.hasPointerCapture = (id) => id === captured;
  button.releasePointerCapture = vi.fn(() => { captured = null; });
  let resolve!: (value: CapturedAudio) => void;
  const result = new Promise<CapturedAudio>((yes) => { resolve = yes; });
  const capture = { start: vi.fn(async () => ({ result, active: true, stop: () => result, cancel() {} })), cancel: vi.fn(), dispose: vi.fn() };
  const onCommit = vi.fn();
  const controller = new PressToTalkController({ sessionKey: "synthetic", capture, onCommit });
  const unbind = bindPressToTalk(button, controller);
  cleanups.push(unbind, () => controller.dispose());
  const pointer = (name: string, clientY = 300, pointerId = 1) => {
    const event = new Event(name);
    Object.assign(event, { clientY, pointerId, button: 0, isPrimary: true });
    button.dispatchEvent(event);
  };
  const finish = async () => {
    const blob = new Blob(["synthetic"]);
    resolve({ blob, size: blob.size, mimeType: "audio/webm", durationMs: 1000 });
    await flush();
  };
  return { button, controller, capture, onCommit, pointer, finish, unbind };
}

describe("bindPressToTalk", () => {
  it("captures the pointer and suppresses its compatibility click", async () => {
    const { button, pointer, finish, onCommit, capture } = setup();
    pointer("pointerdown"); await flush();
    expect(button.setPointerCapture).toHaveBeenCalledWith(1);
    pointer("pointerup");
    button.dispatchEvent(new MouseEvent("click", { detail: 1 }));
    await finish();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(capture.start).toHaveBeenCalledOnce();
    pointer("lostpointercapture");
    expect(button.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it.each(["pointercancel", "lostpointercapture", "slide"])("cancels on %s", async (action) => {
    const { pointer, finish, onCommit, controller } = setup();
    pointer("pointerdown"); await flush();
    pointer(action === "slide" ? "pointermove" : action, 210);
    pointer("pointerup", action === "slide" ? 210 : 300);
    await finish();
    expect(onCommit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("idle");
  });

  it("fails closed if the browser cannot capture the pointer", async () => {
    const { button, pointer, finish, onCommit } = setup();
    button.setPointerCapture = () => { throw new DOMException("missing pointer"); };
    pointer("pointerdown"); await flush(); pointer("pointerup");
    await finish();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("supports native keyboard activation without treating repeats as stops", async () => {
    const { button, controller, finish, onCommit } = setup();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    button.click(); await flush();
    expect(controller.getSnapshot().phase).toBe("recording");
    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, cancelable: true });
    button.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    button.click(); await finish();
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ intent: "send", source: "activation" }));
  });

  it("supports Escape and prevents the long-press context menu", async () => {
    const { button, controller, onCommit, finish } = setup();
    button.click(); await flush();
    const menu = new Event("contextmenu", { cancelable: true });
    button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await finish();
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not swallow a later assistive click after a cancelled pointer", async () => {
    const { button, pointer, controller } = setup();
    pointer("pointerdown"); await flush(); pointer("pointercancel");
    button.click(); await flush();
    expect(controller.getSnapshot().phase).toBe("recording");
  });

  it("unbinds all listeners, cancels capture and restores host styles", async () => {
    const { button, pointer, unbind, capture, onCommit, finish } = setup();
    pointer("pointerdown"); await flush();
    unbind();
    pointer("pointerup"); button.click(); await finish();
    expect(capture.start).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(button.style.userSelect).toBe("");
  });
});
