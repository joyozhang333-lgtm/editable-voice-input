# Contributing

Thanks for helping improve Editable Voice Input.

## Setup

1. Install Node.js 20 or newer.
2. Run `corepack pnpm install`.
3. Run `pnpm check` before opening a pull request.

## Product invariants

- Transcription creates an editable draft; it must not auto-submit.
- Capture is temporary by default and must be cleaned up on cancel and unmount.
- Provider credentials stay server-side.
- Public APIs remain provider-neutral except inside provider adapter packages.
- Examples use fictional content and empty environment values.
- Do not add telemetry, persistence, bundled model files, generated output, or real recordings.

Use a Changeset for behavior or API changes intended for release. Keep pull requests focused and add tests for observable behavior.
