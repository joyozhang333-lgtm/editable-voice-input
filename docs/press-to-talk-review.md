# PressToTalk Review

## Scope

Base: `origin/main` at `5d638f1`; the previous dual-voice branch was already merged. This change adds a framework-neutral controller and optional bindings/UI without replacing existing hooks or changing server storage behavior. Package versions remain `0.2.0-beta.1` with a pending Changeset; vendor consumers should pin the Git revision and SHA-256 manifest until a versioned release is approved.

## Review Findings Addressed

- Enforced explicit stop intent as well as capture termination reason before invoking the host. Permission-pending release cannot queue a later send.
- Kept page lifecycle fencing active during final recorder events and the asynchronous host callback, not just while recording.
- Bound returned dictation to the original operation, session and draft edit revision; edit-and-restore also protects the draft. Send return text is deliberately ignored.
- Prevented compatibility clicks and held-key repeats from re-triggering a recording. Cancelled gestures no longer consume a later assistive activation.
- Kept the same DOM recording button mounted during conversion to text so mode rendering cannot accidentally cancel its transcription. Rechecked operation ownership after synchronous subscriber notifications.
- Preserved the React capture injection type export when promoting the interface into core.
- Added API-specific package consumer checks and standalone server validation that exercises bundled duration dependencies, not just export names. Vendor notices enumerate the transitive bundled graph.
- Validated demo transcript shape before rendering and used React escaping/textContent, not HTML injection. All demo IDs, text and test audio are synthetic.

No unresolved blocking issue is known from this source review. Automated and physical validation boundaries below remain separate from that statement.

## Verification Boundaries

New controller, DOM and React unit tests cover gesture cancellation, permission races, callback failure, automatic termination, same-key session resets, draft revisions, stale returns, cleanup and accessible activation. Browser tests exercise real Chromium MediaRecorder using a synthetic device and mocked transcription on desktop and mobile-touch emulation. Vendoring checks exercise IIFE/ESM and standalone Node CJS with real synthetic WAV duration parsing.

The PR checklist/CI is the source of current execution results; this document is not a claim that every check has already passed. Physical iOS Safari, Android Chrome, WeChat webviews, real permission dialogs/device interruptions, screen readers and real providers are still unverified. Host IndexedDB retention, identity checks and the final send transaction are outside this repository. Abort cannot retract a request already delivered to the host/server; server authorization and idempotency remain required.

No merge or npm publication is part of this delivery.
