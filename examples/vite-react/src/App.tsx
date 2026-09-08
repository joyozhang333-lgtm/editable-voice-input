import { PressToTalkController, type PressToTalkCommit } from "@editable-voice-input/core";
import { PressToTalkInput } from "@editable-voice-input/react";
import { useEffect, useRef, useState } from "react";

interface Message { id: string; text: string; url?: string }

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const urls = useRef<string[]>([]);
  const [controller] = useState(() => new PressToTalkController({
    sessionKey: "anonymous-demo-session",
    async onCommit({ audio, intent, recordingId, signal }: PressToTalkCommit) {
      const response = await fetch("/api/transcribe", {
        method: "POST", headers: { "content-type": audio.mimeType }, body: audio.blob, signal
      });
      if (!response.ok) throw new Error("Transcription unavailable");
      const result = await response.json() as { text: string };
      if (typeof result.text !== "string") throw new Error("Invalid transcript");
      if (signal.aborted) return;
      if (intent === "dictate") return result;
      const url = URL.createObjectURL(audio.blob);
      urls.current.push(url);
      setMessages((current) => [...current, { id: recordingId, text: result.text, url }]);
    }
  }));
  useEffect(() => () => {
    controller.cancel();
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
  }, [controller]);
  return (
    <main className="example-chat">
      <header><span className="example-mark" aria-hidden>evi</span><h1>Editable Voice Input</h1></header>
      <section className="example-messages" aria-label="Messages" aria-live="polite">
        <p className="example-received">Shall we meet at three?</p>
        {messages.map((message) => (
          <article key={message.id} className="example-message">
            {message.url ? <audio controls src={message.url} aria-label="Voice message" /> : null}
            <p>{message.text}</p>
          </article>
        ))}
      </section>
      <footer>
        <PressToTalkInput controller={controller} onSubmitText={({ text }) => {
          setMessages((current) => [...current, { id: crypto.randomUUID(), text }]);
          controller.setSession("anonymous-demo-session", "");
        }} />
      </footer>
    </main>
  );
}
