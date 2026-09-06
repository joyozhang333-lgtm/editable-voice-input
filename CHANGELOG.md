# Changelog

## 0.2.0-beta.1

- Added two explicit voice paths: direct-audio messages and editable dictation.
- Added natural Web Speech restart without overwriting user edits.
- Made browser Web Speech an explicit host opt-in and added batch-only fallback when live recognition is unavailable.
- Added safe stop on media-track end, page hide, and document backgrounding.
- Standardized public durations on `durationMs` while accepting legacy `durationSeconds` inputs.
- Added a product-neutral direct-audio outbox with stable `clientTurnId`, exact lookup reconciliation, response-loss recovery, and a codec-required IndexedDB store.
- Added `@editable-voice-input/adapter-guichu` so GuiChu conversation, session, and owner fields do not enter core.
- Added `useDualModeVoiceInput` and an optional accessible minimal two-mode UI with 44 px controls.
- Fenced outbox stage/send operations across `clear()`, partitioned IndexedDB rows by opaque owner scope, and added identity-epoch checks around asynchronous GuiChu crypto.
- Preserved edits made during batch transcription and existing audio when re-record permission fails; isolated asynchronous host callback failures.
- Cancelled permission requests on page lifecycle exit and serialized same-tick headless starts across both microphone modes.
- Added durable IndexedDB partition epochs and atomic source/target claim CAS so cross-tab clear cannot be undone by a delayed encode or claim.
- Bound GuiChu reconciliation attempts to owner plus identity epoch, with host-aborted identity signals checked before and after lookup/upload.
- Fenced Web Speech restart timers on `pagehide` and hidden documents, and added non-regression coverage thresholds with the GuiChu adapter included.
- Added cross-instance IndexedDB send leases keyed by partition epoch and row revision, with checks around lookup/upload and revision-conditional cleanup after clear or claim.
- Treat validated server responses as durable receipts, so an aborted local delete reports success with `cleanupPending` and remains recoverable.
- Made Web Speech synchronous start failures clean up listeners and surface `VoiceInputError`, and made multiple custom IndexedDB store names safe in one database through a schema registry.
- Made custom-store schema upgrades reopen and retry across independent browser realms while preserving unrelated host stores.
- Linked source/target identity cancellation through server claim reconciliation and the final atomic IndexedDB guest-to-account move.
- Added an optional GuiChu server identity preflight while requiring atomic owner/session/identity-epoch authorization at the lookup/upload boundary.
- Enforced coverage thresholds in CI rather than running the non-coverage test command.

This beta has automated unit, type, build, package-consumer, secret-scan, and dependency-audit coverage. Physical iPhone Safari and Android Chrome recording/transcription tests are still required before a stable `0.2.0` release.
