import { EditableVoiceInput, type Transcriber } from "@editable-voice-input/react";
import { useState } from "react";

const transcribe: Transcriber = async ({ blob, mimeType, signal }) => {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": mimeType },
    body: blob,
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error("转写服务暂时不可用");
  return response.json();
};

export function App() {
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");

  return (
    <main className="example-shell">
      <div className="example-copy">
        <p className="example-eyebrow">Editable Voice Input</p>
        <h1>先说出来，再决定怎么表达。</h1>
        <p>试着说一句虚构日程，例如：“周六上午去公园散步”。转写后可以继续编辑，不会自动发送。</p>
      </div>

      <EditableVoiceInput
        className="example-composer"
        value={draft}
        onValueChange={setDraft}
        transcribe={transcribe}
        labels={{
          draft: "可编辑语音草稿",
          placeholder: "输入文字，或点击录音",
          record: "录音",
          stop: "停止",
          cancel: "取消",
          removeRecording: "移除录音",
          submit: "确认提交",
          requesting: "正在请求麦克风权限…",
          recording: "正在录音",
          transcribing: "正在转成文字…",
          review: "可以修改文字，确认后再提交",
          error: "语音输入未完成",
          playback: "录音回听"
        }}
        onSubmit={({ text }) => setSubmitted(text)}
      />

      {submitted ? (
        <aside className="example-result" aria-live="polite">
          <span>已明确提交</span>
          <p>{submitted}</p>
        </aside>
      ) : null}
    </main>
  );
}
