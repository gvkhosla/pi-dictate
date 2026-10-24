# Release verification

## v1.0.0

- Clean `npm ci --ignore-scripts`, TypeScript checks, and 25 automated tests pass locally on macOS/Apple Silicon.
- Tests cover capture, silence/clipping, prompt preservation, repeated Enter, cancellation, process termination, temporary-file permissions/cleanup, and model-install checksum failures.
- Real Pi TUI smoke tests pass at 80 and 40 columns, using a synthetic microphone. They require no model or microphone permission.
- The maintainer confirmed successful live `/talk` microphone dictation before this release.
- Both `base.en` and `small.en` downloads passed SHA-256 verification. Both locally transcribed a generated audio sample as: “Please add a dark mode toggle to the settings page and run the tests.” This is a smoke test, not an accuracy benchmark.
- The small model is optional; installing it does not change the default model.
- GitHub CI passes on macOS and Linux, including the real Pi TUI smoke tests. Linux capture uses subprocess fixtures; actual microphone capture is macOS-only.
- A clean release tree without node_modules or models loads into Pi and passes the synthetic TUI smoke tests.
- `npm audit` reports zero known vulnerabilities in the locked development dependencies.
- Audio, models, local paths, credentials, and generated terminal captures are excluded from the repository.

## Limits

Intel Mac hardware and non-English recognition have not been manually verified. Recognition quality depends on the model and recording conditions. A forced kill can bypass temporary-file cleanup. See README for the privacy boundary and configuration.
