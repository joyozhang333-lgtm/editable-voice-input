# Privacy

Editable Voice Input is designed around temporary voice capture.

## Library behavior

- No telemetry or analytics.
- No database, browser storage, service worker cache, or recording persistence is enabled by default.
- Object URLs are revoked when recordings are replaced, cleared, or the component unmounts.
- In batch mode, audio is sent only when transcription is requested after recording stops.
- In direct-audio mode, audio is sent only through the host-supplied transport. `uploadOnStop` is disabled by default.
- A transcript remains an editable draft until the user explicitly submits it.
- Interim dictation is kept separately from the editable value and is not persisted by the library.
- The optional IndexedDB outbox store can persist pending audio only when the host explicitly constructs it with a codec and an opaque owner partition. The partition and its mutation epoch are plaintext row metadata, so the partition must be an unlinkable tag rather than a raw account identifier. The codec is responsible for encryption, owner binding, expiry, and account-transition behavior. Product conversation/session scope stays inside the encrypted payload.

## Browser speech recognition

The optional Web Speech provider is implemented by the browser. Depending on browser and operating system, speech may be processed by a vendor service rather than on-device. `useEditableDictation` does not enable it by default. Host applications must feature-detect, identify the actual provider where possible, disclose this processing, obtain the consent required for their product, and only then pass `enableBrowserWebSpeech: true`. Applications that require a known processor should inject their own `DictationProvider` instead.

## Host application responsibilities

The library returns the audio `Blob` because some products need custom workflows. If a host stores or forwards audio or transcripts, that host is responsible for consent, purpose disclosure, data minimization, access control, encryption, retention, deletion, export, subprocessors, and applicable law. Direct-audio playback URLs must be authorized, revocable where practical, and excluded from analytics logs.

Avoid logging raw request bodies, transcripts, provider responses, or authorization headers.
