# Changelog

## Unreleased

- Optional local vocabulary hints via `/talk vocab`, with an environment default, bounded input, off/reset controls, and session cleanup. No automatic transcript rewriting.
- Checksum-verified `medium.en` as an explicit alternative; keep `small.en` as default.
- Reproducible local four-condition benchmark, synthetic coding corpus, WER/latency measurements, and support for private prerecorded comparisons.

- Guided first-run `/talk` setup: explicit consent, installation/download progress, Escape cancellation, and automatic recording when ready.
- Respect custom binary/model paths; never install Homebrew itself or modify invalid overrides automatically.
- Cancel setup safely on reload/session shutdown and prevent duplicate setup runs.
- Use `small.en` by default for potentially better recognition; retain `base.en` as an explicit lighter option.
- Setup now downloads and verifies `small.en` unless a model is specified.

## 1.0.0

First public release.

- Local macOS dictation: `/talk` starts; Enter inserts the transcript; Esc cancels.
- Live microphone-level history, elapsed time, and theme-aware narrow-terminal layout.
- Quiet-input and clipping warnings with actionable guidance.
- Optional checksum-verified `small.en` model download alongside the lightweight default.
- Prompt preservation and protection against accidental submission during inference.
- Bounded recording, cancellation, subprocess termination, and private temporary-file cleanup.
- Guided dependency setup, MIT license, contributor/security docs, and automated CI.
