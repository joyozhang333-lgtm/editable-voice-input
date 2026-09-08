import type { PressToTalkController } from "./press-to-talk";

/** Bind one native button. Its accessible click path toggles start/stop without a held key. */
export function bindPressToTalk(
  button: HTMLButtonElement,
  controller: PressToTalkController
): () => void {
  let pointerId: number | null = null;
  let pointerClickPending = false;
  let clickReset: ReturnType<typeof setTimeout> | undefined;
  const oldTouchAction = button.style.touchAction;
  const oldUserSelect = button.style.userSelect;
  button.style.touchAction = "none";
  button.style.userSelect = "none";

  const release = () => {
    const id = pointerId;
    pointerId = null;
    if (id !== null && button.hasPointerCapture?.(id)) button.releasePointerCapture(id);
  };
  const down = (event: PointerEvent) => {
    clearTimeout(clickReset);
    pointerClickPending = controller.pointerDown(event);
    if (!pointerClickPending) return;
    pointerId = event.pointerId;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      controller.pointerCancel(event.pointerId);
      release();
      pointerClickPending = false;
    }
  };
  const move = (event: PointerEvent) => controller.pointerMove(event);
  const up = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    // Clear local ownership before synchronous state notifications/release events.
    release();
    controller.pointerUp(event);
    clickReset = setTimeout(() => { pointerClickPending = false; }, 0);
  };
  const cancel = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    release();
    controller.pointerCancel(event.pointerId);
    pointerClickPending = false;
  };
  const click = (event: MouseEvent) => {
    if (pointerClickPending || event.detail > 0) {
      pointerClickPending = false;
      return;
    }
    const phase = controller.getSnapshot().phase;
    if (phase === "recording" || phase === "requesting-permission") controller.stop();
    else void controller.start();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); controller.cancel(); }
    if (event.key === "Enter" || event.key === " ") {
      pointerClickPending = false;
      if (event.repeat) event.preventDefault();
    }
  };
  const contextMenu = (event: Event) => event.preventDefault();
  const unsubscribe = controller.subscribe(() => {
    if (!["recording", "requesting-permission"].includes(controller.getSnapshot().phase)) {
      release();
    }
  });
  button.addEventListener("pointerdown", down);
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("lostpointercapture", cancel);
  button.addEventListener("click", click);
  button.addEventListener("keydown", key);
  button.addEventListener("contextmenu", contextMenu);
  return () => {
    clearTimeout(clickReset);
    unsubscribe();
    button.removeEventListener("pointerdown", down);
    button.removeEventListener("pointermove", move);
    button.removeEventListener("pointerup", up);
    button.removeEventListener("pointercancel", cancel);
    button.removeEventListener("lostpointercapture", cancel);
    button.removeEventListener("click", click);
    button.removeEventListener("keydown", key);
    button.removeEventListener("contextmenu", contextMenu);
    release();
    button.style.touchAction = oldTouchAction;
    button.style.userSelect = oldUserSelect;
    controller.cancel();
  };
}
