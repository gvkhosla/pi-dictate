# Contributing

Keep the interaction small: `/talk` → Enter → editable prompt. Never auto-send,
upload audio, or start the microphone when the extension loads.

## Local checks

Use Node.js 24+ and Python 3:

```sh
npm ci --ignore-scripts
npm run check
npm run test:tui
bash -n scripts/setup.sh
```

The Pi dev packages are pinned for reproducible tests; at runtime the extension uses the host's
peer packages. A development-only override pins a patched undici version for Pi's test installation;
it does not modify the user's installed Pi. CI runs on macOS and Linux, but actual audio capture is macOS-only.
Tests must use synthetic input, not an open microphone or network inference.

## Code layout

- `src/backend.ts`: dependency discovery, bounded capture, local inference, process/file cleanup.
- `src/index.ts`: command lifecycle, cancellation, prompt insertion.
- `src/widget.ts`: theme-aware, width-bounded recording UI.
- `scripts/setup.sh`: explicit dependency/model installation with pinned checksums.
- `test/`: unit, subprocess, installer, and real-Pi terminal tests.

Include regression tests for changes. For recording/inference changes, check cancellation,
reload/shutdown cleanup, and preservation of text typed during transcription.
For UI changes, keep Enter/Esc discoverable at narrow widths and use Pi's semantic theme colors.

Please don't attach real recordings, private prompts, credentials, generated terminal captures,
or model weights to pull requests. Use a minimal synthetic reproduction.
Report security issues privately as described in [SECURITY.md](SECURITY.md).
