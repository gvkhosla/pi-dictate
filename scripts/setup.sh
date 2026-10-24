#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-base.en}" in
  base.en) NAME="base.en"; SHA="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" ;;
  small.en) NAME="small.en"; SHA="c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" ;;
  -h|--help) echo "Usage: bash scripts/setup.sh [base.en|small.en]"; exit 0 ;;
  *) echo "Unknown model. Choose base.en (148 MB) or small.en (488 MB)." >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Darwin ]] || { echo "pi-dictate currently supports macOS." >&2; exit 1; }
if ! command -v sox >/dev/null || ! command -v whisper-cli >/dev/null; then
  command -v brew >/dev/null || { echo "Install Homebrew from https://brew.sh, then rerun setup." >&2; exit 1; }
fi
command -v sox >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install sox
command -v whisper-cli >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install whisper.cpp
mkdir -p "$ROOT/models"
MODEL="$ROOT/models/ggml-$NAME.bin"
ready() {
  echo "Local $NAME model ready. Run: pi install \"$ROOT\""
  if [[ "$NAME" != base.en ]]; then
    printf 'To use this model, launch Pi with: PI_DICTATE_MODEL=%q pi\n' "$MODEL"
  fi
}
if [[ -f "$MODEL" ]] && echo "$SHA  $MODEL" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "Local Whisper model already verified."
  ready
  exit 0
fi
PART="$(mktemp "$ROOT/models/download.XXXXXX")"
trap 'rm -f "$PART"' EXIT
curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$NAME.bin" -o "$PART"
echo "$SHA  $PART" | shasum -a 256 -c -
mv "$PART" "$MODEL"
ready
