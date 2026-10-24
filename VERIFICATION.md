# Release verification

## Unreleased: vocabulary and model comparison

- 47 automated tests and TypeScript checks pass locally, including opt-in prompt arguments, length/control-character normalization, session override/off/reset behavior, and session cleanup.
- Real Pi terminal tests pass at 80 and 40 columns, including vocabulary configuration before both ready-to-record and guided-setup flows. The fixture verifies hints reach inference; microphone input is synthetic.
- Downloaded `medium.en` and verified its pinned SHA-256. The default remains `small.en`.
- Ran 80 measured local transcriptions over ten generated coding requests, comparing both models with/without vocabulary. Full method, limitations, timings, and synthetic transcripts are in [benchmarks/README.md](benchmarks/README.md).
- No human recordings were captured or used for this comparison. It does not establish recognition quality for the maintainer's voice or accent.

## Earlier unreleased: guided first-run setup

- 41 tests and TypeScript checks pass locally, including decline/no-install, custom overrides, setup failures, single-flight preparation, cancellation of installer subprocesses, and shutdown before microphone activation.
- Real Pi TUI smoke tests pass at 80 and 40 columns for both ready installs and first-run confirmation/progress. The installer and microphone are synthetic in these tests; they do not modify Homebrew or download models.
- Existing local `small.en` inference still transcribes the generated smoke sample successfully.
- These changes target `main` after v1.0.0; no new release tag is included. Check the repository's GitHub Actions runs for remote CI results.

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
