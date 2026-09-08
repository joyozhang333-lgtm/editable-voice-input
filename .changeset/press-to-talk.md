---
"@editable-voice-input/core": patch
"@editable-voice-input/react": patch
---

Add framework-neutral PressToTalkController and shared native-button binding with explicit send/dictate intent, pointer cancellation, accessible activation, session fences and non-destructive draft reconciliation. Add the minimal PressToTalkInput React component without changing existing APIs. Provide reproducible standalone browser IIFE/ESM and Node server/provider CJS vendor builds in the repository, with dependency notices and isolated consumer checks. No audio storage or automatic transcript submission is enabled.
