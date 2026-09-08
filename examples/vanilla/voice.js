/* global EditableVoiceInputCore */
const { PressToTalkController, bindPressToTalk } = EditableVoiceInputCore;
const element = (id) => document.getElementById(id);
const draft = element("draft");
const hold = element("hold");
const mode = element("mode");
const mic = element("mic");
const cancel = element("cancel");
const sendText = element("send-text");
const urls = new Set();
const sessionKey = "anonymous-demo-session";

function appendMessage(text, audio) {
  const message = document.createElement("article");
  if (audio) {
    const player = document.createElement("audio");
    player.controls = true;
    player.src = URL.createObjectURL(audio.blob);
    urls.add(player.src);
    message.append(player);
  }
  const copy = document.createElement("p");
  copy.textContent = text;
  message.append(copy);
  element("messages").append(message);
}

const voice = new PressToTalkController({
  sessionKey,
  async onCommit({ audio, intent, sessionKey: originalScope, signal }) {
    const response = await fetch("/api/transcribe", {
      method: "POST", headers: { "content-type": audio.mimeType }, body: audio.blob, signal
    });
    if (!response.ok) throw new Error("Transcription unavailable");
    const result = await response.json();
    if (typeof result.text !== "string") throw new Error("Invalid transcript");
    if (signal.aborted || originalScope !== sessionKey) return;
    if (intent === "dictate") return result;
    // This example is tab-memory-only. A host can instead invoke its scoped send/IndexedDB workflow.
    appendMessage(result.text, audio);
  }
});
const unbind = bindPressToTalk(hold, voice);

function render() {
  const state = voice.getSnapshot();
  const textMode = state.mode === "dictate";
  const recording = state.phase === "recording";
  const pending = state.phase === "requesting-permission";
  const active = state.phase !== "idle" && state.phase !== "error";
  draft.hidden = mic.hidden = sendText.hidden = !textMode;
  hold.hidden = textMode;
  // Do not rewrite an equal value: preserve selection/composition while the host edits.
  if (draft.value !== state.text) draft.value = state.text;
  mode.textContent = textMode ? "语音" : "转文字";
  hold.textContent = state.cancelPending ? "松开取消" : recording ? "松开发送" : "按住说话，松开发送";
  hold.dataset.cancelling = String(state.cancelPending);
  hold.setAttribute("aria-pressed", String(recording));
  hold.setAttribute("aria-label", recording ? "松开发送；也可点击激活停止并发送" : "按住说话，松开发送；也可点击激活开始录音");
  mic.textContent = recording || pending ? "停止听写" : "听写";
  mic.disabled = ["stopping", "committing"].includes(state.phase);
  cancel.hidden = !active;
  sendText.disabled = active || !state.text.trim();
  const labels = { "requesting-permission": "等待麦克风权限", stopping: "正在结束录音", transcribing: "正在转文字", committing: "正在处理语音" };
  element("status").textContent = state.error?.message ?? labels[state.phase] ?? (recording ? `${Math.floor(state.elapsedMs / 1000)}s` : "");
  element("suggestion").hidden = state.transcriptSuggestion === null;
  element("suggestion").querySelector("p").textContent = state.transcriptSuggestion ?? "";
}
const unsubscribe = voice.subscribe(render);
render();
draft.addEventListener("input", () => voice.setText(draft.value));
mode.addEventListener("click", () => {
  const state = voice.getSnapshot();
  if (state.mode === "dictate") voice.setMode("send");
  else if (["recording", "requesting-permission"].includes(state.phase)) voice.stopToDictate();
  else voice.setMode("dictate");
  if (voice.getSnapshot().mode === "dictate") draft.focus();
});
mic.addEventListener("click", () => {
  if (["recording", "requesting-permission"].includes(voice.getSnapshot().phase)) voice.stop();
  else void voice.start({ intent: "dictate" });
});
cancel.addEventListener("click", voice.cancel);
element("composer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") voice.cancel();
});
sendText.addEventListener("click", () => {
  const state = voice.getSnapshot();
  appendMessage(state.text.trim());
  voice.setSession(sessionKey, "");
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return; // The controller separately cancels capture for bfcache entry.
  unsubscribe(); unbind(); voice.dispose();
  for (const url of urls) URL.revokeObjectURL(url);
});
