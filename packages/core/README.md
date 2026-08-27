# @editable-voice-input/core

Browser capture, MIME negotiation, lifecycle-safe object URLs, shared state and error types, and transcript draft merging. Overlapping starts are rejected, and cancelling while browser permission is pending releases any stream that arrives afterward. See the repository README for usage.

```ts
import { BrowserVoiceCapture } from "@editable-voice-input/core";

const capture = new BrowserVoiceCapture({ maxDurationMs: 120_000, maxBytes: 8 * 1024 * 1024 });
const session = await capture.start();
const audio = await session.stop(); // in-memory Blob; nothing is uploaded by core
capture.dispose();
```

Capture requires a secure browser context and a user gesture. Always offer cancel and make the resulting transcript editable before submission.
