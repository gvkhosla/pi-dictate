# pi-dictate

**Talk to Pi. Keep your audio on your Mac.**

A small, local speech-to-text extension for [Pi](https://pi.dev).
Run `/talk`, speak, press **Enter**. Your words appear in the prompt for review—not automatically sent.

```text
● Recording  ▁▂▃▆█▅▃▂▁▁▂▃  0:12  Enter transcribe · Esc cancel · local
──────────────────────────────────────────────────────────────────────
Please add a dark mode toggle to the settings page and run the tests.
──────────────────────────────────────────────────────────────────────
```

Illustrative terminal preview. The actual meter responds to your microphone.

## Install

Requires **macOS**, **Node.js 24+**, [Homebrew](https://brew.sh), and **Pi 1.4+**.
Live dictation has been confirmed on Apple Silicon; Intel Mac hardware has not been tested.

```sh
git clone --branch v1.0.0 https://github.com/gvkhosla/pi-dictate.git
cd pi-dictate
bash scripts/setup.sh
pi install "$PWD"
```

Then run **`/reload`** in Pi.

Setup installs missing SoX and whisper.cpp through Homebrew (which may also update their dependencies),
downloads the English Whisper base model (~148 MB), and verifies its SHA-256.
No `npm install` is needed to use the extension; Pi supplies its runtime packages.
The checkout must remain at the installed path.

## Use

| Action | Result |
| --- | --- |
| `/talk` then Enter | Start recording |
| Enter while recording | Stop and transcribe into the prompt |
| Enter after reviewing | Send the prompt normally |
| Esc | Cancel recording or transcription |
| `/talk status` | Check dependencies and show the active model |
| `/talk cancel` | Cancel programmatically; Esc is the keyboard path |

Typing while recording or transcribing is preserved. Extra Enter presses during transcription
are consumed, not queued as a send. Recording stops automatically after two minutes.

A compact live level history and timer sit above the editor, using your Pi theme.
A **quiet mic** warning appears after three seconds of very low input; a **clipping** warning
suggests lowering input volume. These measure audio levels, not whether you're speaking.

No function keys, system-wide keyboard listener, or Input Monitoring permission.

### Microphone permission

Allow your terminal microphone access when macOS asks. If it doesn't work:

1. Enable your terminal under **System Settings → Privacy & Security → Microphone**.
2. Restart the terminal.
3. Check **System Settings → Sound → Input** for the correct microphone and input volume.
4. Run `/talk status`, then try `/talk` again.

If macOS is still waiting for permission when recording times out, grant permission and retry.

## Optional higher-accuracy model

The default `base.en` model favors a small download and lighter inference.
Try `small.en` for potentially better recognition, at the cost of more memory and longer inference.
Accuracy and speed depend on your speech, recording conditions, and hardware.

From the checkout:

```sh
bash scripts/setup.sh small.en
export PI_DICTATE_MODEL="$PWD/models/ggml-small.en.bin"
```

The larger model is ~488 MB and checksum-verified. Start Pi from your project in that shell
to use it. Add the exported absolute path to your shell configuration if you want it persistent.
Use `unset PI_DICTATE_MODEL` before launching Pi to return to the default.

Setup never silently switches the active model or downloads both models.

## Configuration

Set these environment variables **before launching Pi**:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_DICTATE_MODEL` | Checkout's `models/ggml-base.en.bin` | Absolute path to a whisper.cpp GGML model |
| `PI_DICTATE_LANGUAGE` | `en` | Whisper language code |
| `PI_DICTATE_SOX` | Found on PATH / Homebrew | Absolute path to SoX |
| `PI_DICTATE_WHISPER` | Found on PATH / Homebrew | Absolute path to whisper-cli |

For other languages, supply a multilingual model—not an English-only `.en` model.
There is no cloud fallback.

## Privacy and limits

- No API key, audio upload, runtime download, or telemetry in this extension.
- The microphone opens only when you run `/talk`, and closes before transcription.
- Up to two minutes of PCM audio are buffered in memory.
- Inference uses a private temporary directory, removed on success, failure, cancellation, or normal shutdown.
  A forced process/OS kill can leave temporary files in the OS temp directory.
- Audio and transcripts are not logged by the extension. Models stay on disk.
- **Text you choose to send to Pi goes to your configured Pi model as usual.**
- Whisper can mishear or hallucinate, especially with noise. Review before sending.

This is a macOS-only, English-default v1. No live transcript, background model server,
automatic sending, global hotkey, or cloud service.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:tui
```

Tests use synthetic audio and subprocess fixtures; they never open a microphone.
The real Pi terminal smoke test needs Python 3 and runs at 80 and 40 columns.
Neither test suite needs Homebrew, a Whisper model, or model credentials.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [VERIFICATION.md](VERIFICATION.md).

To remove the installed extension, run from the checkout:

```sh
pi remove "$PWD"
```

Run `/reload` afterward. Removing the extension does not uninstall Homebrew packages or downloaded models.

## License and credits

[MIT](LICENSE). Built on [Pi](https://pi.dev), [SoX](https://sox.sourceforge.net),
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), and
[OpenAI Whisper](https://github.com/openai/whisper).
Models and third-party software retain their own licenses; they are not bundled in this repository.
