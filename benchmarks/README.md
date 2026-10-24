# Local recognition benchmark

A small reproducible baseline, **not a benchmark of the user's voice**.

## Observed result

Apple M3 Max, 36 GiB RAM, macOS arm64, Node 24.18.0, whisper.cpp 1.9.5.
Ten synthetic English requests using macOS's Samantha voice at alternating 165/185 words per minute.
Each recording was transcribed twice in each condition: **80 measured calls**, plus four excluded warmups.

| Model | Vocabulary hints | Word error rate | Median wall time |
| --- | --- | ---: | ---: |
| small.en | Off | 6.67% | 0.384 s |
| small.en | On | 0.00% | 0.388 s |
| medium.en | Off | 3.81% | 0.885 s |
| medium.en | On | 0.00% | 0.891 s |

[Full synthetic results](results/m3-max.json) include every reference, transcript, error count, and latency.
The two repetitions are not independent utterances. Zero measured errors does **not** mean perfect
recognition, and the corpus is too small for broad model-quality claims.

Examples without hints: small.en heard “shadow and” for “shadcn”, “videst” for “Vitest”,
and “high dictate” for “pi-dictate”; medium.en still missed “shadcn”, “Vitest”, and “Supabase”.
Both models matched the normalized references with hints in this run.

**Decision:** keep small.en as default. Try relevant vocabulary before paying the larger model's
download/memory/latency costs. Compare recordings from your own voice before changing models.

## Method and limitations

- Same PCM bytes in all four conditions. Condition order rotates to reduce fixed ordering bias.
- Every call starts a fresh whisper-cli, including process startup, model loading, and temporary-file I/O
  in its wall time. OS caches are warmed; this is not a cold-machine latency measurement.
- Uses the production transcription path, English language, and Whisper's default backend/thread settings.
- The same fixed short glossary is supplied in both hinted conditions; it contains the technical names
  used in the corpus, **not the reference sentences**. This represents a known project vocabulary, not
  unfamiliar names. Vocabulary is disabled in both unhinted conditions, regardless of environment defaults.
- Word error rate = (substitutions + deletions + insertions) / reference words.
  Unicode-normalized text is lowercased and split on non-letter/non-number characters.
  Capitalization and punctuation differences are ignored; spelling, split words, and negation errors are not.
  Alternate equivalent wording may still count as an error. Individual substitution/deletion/insertion
  alignments can be ambiguous; total edit distance is the comparison metric.
- No rewriter, autocorrect, speech uploads, live microphone, or cloud model.
- One clean synthetic voice cannot evaluate accents, TTS pronunciation errors, real microphones,
  background noise, overlap, long recordings, or hallucination risk. Relevant hints can also bias
  recognition toward words the speaker never said. Continue reviewing before sending.

Pinned model SHA-256:
- small.en: `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`
- medium.en: `cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356`

## Repeat the synthetic comparison

From a macOS checkout with Node 24+, SoX, whisper-cli, and the Samantha voice available:

```sh
bash scripts/setup.sh small.en
bash scripts/setup.sh medium.en
npm run benchmark
```

Setup may download/install dependencies and the requested models. The benchmark itself stays offline
and never opens the microphone. It saves generated audio, a JSON report, and a Markdown summary to a
new private directory under gitignored `.scratch/benchmark-*`. These artifacts are intentionally
retained for inspection; delete the printed run directory when no longer needed. Ctrl-C cancels the
active subprocess and leaves any benchmark artifacts already generated.

## Compare your own recordings

Keep real audio, transcripts, and reports private. Prepare approximately ten representative requests,
with an accurate reference transcript for each. Convert each existing recording to mono 16 kHz s16le PCM:

```sh
sox recording.wav -r 16000 -c 1 -b 16 -e signed-integer -L -t raw recording.pcm
```

Create a manifest in a private directory (PCM paths resolve relative to it):

```json
{
  "label": "My coding requests",
  "synthetic": false,
  "vocabulary": "TypeScript, shadcn, Vitest",
  "samples": [
    {
      "id": "settings",
      "text": "Add a dark mode toggle to the settings page.",
      "pcm": "recording.pcm"
    }
  ]
}
```

Then run from the checkout:

```sh
npm run benchmark -- /absolute/path/to/private/corpus.json 2
```

The final argument is repetitions (1–5; default 2). Recordings must contain speech and be at most
120 seconds; the raw PCM format cannot be auto-detected. Failed transcription aborts the run rather
than silently dropping a sample. The benchmark does not copy private source PCM files, but it **does**
save their reference text and recognized text locally. Never attach human recordings or private
benchmark reports to public issues.
