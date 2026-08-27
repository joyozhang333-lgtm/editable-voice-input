import type { Metadata } from "next";
import "@editable-voice-input/react/styles.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Editable Voice Input · Next.js example",
  description: "Record, transcribe, edit, and explicitly submit."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
