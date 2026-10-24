#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-small.en}" in
  base.en) NAME="base.en"; SHA="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" ;;
  small.en) NAME="small.en"; SHA="c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" ;;
  -h|--help) echo "Usage: bash scripts/setup.sh [small.en|base.en] (default: small.en)"; exit 0 ;;
  *) echo "Unknown model. Choose base.en (148 MB) or small.en (488 MB)." >&2; exit 1 ;;
esac
DEPENDENCIES_ONLY="${2:-}"
[[ -z "$DEPENDENCIES_ONLY" || "$DEPENDENCIES_ONLY" == --dependencies-only ]] || { echo "Unknown setup option." >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo "pi-dictate currently supports macOS." >&2; exit 1; }
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
SOX="${PI_DICTATE_SOX:-$(command -v sox || true)}"
WHISPER="${PI_DICTATE_WHISPER:-$(command -v whisper-cli || true)}"
if [[ -n "$SOX" && ( ! -x "$SOX" || ! -f "$SOX" ) ]]; then echo "Invalid SoX override." >&2; exit 1; fi
if [[ -n "$WHISPER" && ( ! -x "$WHISPER" || ! -f "$WHISPER" ) ]]; then echo "Invalid Whisper override." >&2; exit 1; fi
if [[ -z "$SOX" || -z "$WHISPER" ]]; then
  command -v brew >/dev/null || { echo "Install Homebrew from https://brew.sh, then rerun setup." >&2; exit 1; }
fi
if [[ -z "$SOX" ]]; then
  echo "PI_DICTATE_PROGRESS=Installing SoX…"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install sox
fi
if [[ -z "$WHISPER" ]]; then
  echo "PI_DICTATE_PROGRESS=Installing whisper.cpp…"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install whisper.cpp
fi
if [[ "$DEPENDENCIES_ONLY" == --dependencies-only ]]; then echo "Local dependencies ready."; exit 0; fi
mkdir -p "$ROOT/models"
MODEL="$ROOT/models/ggml-$NAME.bin"
ready() {
  echo "Local $NAME model ready. Run: pi install \"$ROOT\""
  if [[ "$NAME" != small.en ]]; then
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
trap 'exit 130' INT
trap 'exit 143' TERM
echo "PI_DICTATE_PROGRESS=Downloading $NAME model…"
curl --fail --location --progress-bar --retry 3 --connect-timeout 20 --max-time 600 \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$NAME.bin" -o "$PART"
echo "PI_DICTATE_PROGRESS=Verifying model checksum…"
echo "$SHA  $PART" | shasum -a 256 -c -
mv "$PART" "$MODEL"
ready
