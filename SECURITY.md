# Security

Report vulnerabilities privately using
[GitHub's vulnerability reporting](https://github.com/gvkhosla/pi-dictate/security/advisories/new).
Do not include real recordings, private transcripts, API keys, or other people's data in a public issue.

The extension runs with Pi's operating-system permissions. It executes local SoX and whisper-cli
binaries, reads a local model, and temporarily writes microphone audio for inference.
Only use executables and model files you trust. Setup downloads are checksum-verified.

There is no audio upload or cloud transcription. Submitted prompts still follow Pi's normal
model-provider configuration. Temporary files are cleaned up during normal operation,
not guaranteed after a forced kill or OS crash.

Security fixes target the latest release. This small project has no guaranteed response SLA.
