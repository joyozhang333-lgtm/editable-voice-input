# Privacy

Editable Voice Input is designed around temporary voice capture.

## Library behavior

- No telemetry or analytics.
- No database, browser storage, service worker cache, or recording persistence.
- Object URLs are revoked when recordings are replaced, cleared, or the component unmounts.
- Audio is sent only when transcription is requested after recording stops.
- A transcript remains an editable draft until the user explicitly submits it.

## Host application responsibilities

The library returns the audio `Blob` because some products need custom workflows. If a host stores or forwards audio or transcripts, that host is responsible for consent, purpose disclosure, data minimization, access control, encryption, retention, deletion, export, subprocessors, and applicable law.

Avoid logging raw request bodies, transcripts, provider responses, or authorization headers.
