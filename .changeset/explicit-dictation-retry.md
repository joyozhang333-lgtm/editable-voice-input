---
"@editable-voice-input/core": patch
"@editable-voice-input/react": patch
"@editable-voice-input/server": patch
---

Retain a completed dictate take in memory after ASR failure for explicit user-triggered retry, without retrying audio sends. Expose a retry button in the optional React composer and an opt-in server transcript postprocessing hook for host-controlled Simplified Chinese normalization.
