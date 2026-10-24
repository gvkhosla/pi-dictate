// Local-only benchmark. Never opens a microphone or downloads a model.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, platform, arch, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, transcribe, MAX_SECONDS, SAMPLE_RATE } from "../src/backend.ts";
import { normalizeVocabulary } from "../src/configuration.ts";
import { median, wordErrors } from "./benchmark-metrics.ts";

interface Sample { id: string; text: string; rate?: number; pcm?: string }
interface Corpus { label: string; synthetic: boolean; vocabulary: string; samples: Sample[] }
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = resolve(process.argv[2] ?? join(root, "benchmarks/coding.json"));
const repeats = Number(process.argv[3] ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("Repetitions must be an integer from 1 to 5.");
const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as Corpus;
if (typeof corpus.label !== "string" || typeof corpus.synthetic !== "boolean" || !Array.isArray(corpus.samples) || !corpus.samples.length || corpus.samples.length > 100) throw new Error("Invalid corpus metadata or sample count.");
const vocabulary = normalizeVocabulary(corpus.vocabulary);
if (!vocabulary) throw new Error("Provide a short vocabulary for the hints comparison.");
const ids = new Set<string>();
for (const sample of corpus.samples) {
  if (!/^[a-z0-9-]+$/.test(sample.id) || ids.has(sample.id) || typeof sample.text !== "string" || !wordErrors(sample.text, "").words) throw new Error("Samples need unique simple IDs and nonempty reference text.");
  if (sample.rate !== undefined && (!Number.isInteger(sample.rate) || sample.rate < 80 || sample.rate > 300)) throw new Error("Speech rate must be 80–300 words/minute.");
  if (!corpus.synthetic && !sample.pcm) throw new Error("Human-recorded corpora require a PCM path for every sample.");
  if (corpus.synthetic && sample.pcm) throw new Error("Synthetic corpora generate audio; do not mix in external PCM.");
  ids.add(sample.id);
}
const base = getConfig();
const variants = [
  { model: "small.en", hints: false },
  { model: "small.en", hints: true },
  { model: "medium.en", hints: false },
  { model: "medium.en", hints: true },
];
for (const model of new Set(variants.map((v) => v.model))) {
  try { await access(join(root, "models", `ggml-${model}.bin`)); }
  catch { throw new Error(`Missing ${model}. Run bash scripts/setup.sh ${model} first.`); }
}
await mkdir(join(root, ".scratch"), { recursive: true });
const output = await mkdtemp(join(root, ".scratch/benchmark-"));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const audio = new Map<string, Buffer>();
  for (const sample of corpus.samples) {
    let pcmPath: string;
    if (corpus.synthetic) {
      const aiff = join(output, sample.id + ".aiff");
      pcmPath = join(output, sample.id + ".pcm");
      await exec("/usr/bin/say", ["-v", "Samantha", "-r", String(sample.rate ?? 175), "-o", aiff, "--", sample.text], { signal: controller.signal });
      await exec(base.sox, [aiff, "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-L", "-t", "raw", pcmPath], { signal: controller.signal });
    } else {
      pcmPath = resolve(dirname(corpusPath), sample.pcm!);
    }
    const size = (await stat(pcmPath)).size;
    if (!size || size % 2 || size > MAX_SECONDS * SAMPLE_RATE * 2) throw new Error("PCM must be nonempty mono s16le at 16 kHz, at most two minutes.");
    audio.set(sample.id, await readFile(pcmPath));
  }
  const version = await exec(base.whisper, ["--version"], { signal: controller.signal });
  const rows: Array<{
    sample: string; model: string; hints: boolean; repetition: number; seconds: number;
    audioSeconds: number; reference: string; transcript: string; score: ReturnType<typeof wordErrors>;
  }> = [];
  const invoke = (variant: typeof variants[number], pcm: Buffer) => transcribe(pcm, {
    ...base, model: join(root, "models", `ggml-${variant.model}.bin`), language: "en",
    vocabulary: variant.hints ? vocabulary : undefined,
  }, controller.signal);
  // Warm OS caches once per condition. Each measured call still starts a fresh CLI process.
  for (const variant of variants) await invoke(variant, audio.get(corpus.samples[0].id)!);
  for (let repetition = 0; repetition < repeats; repetition++) {
    for (let s = 0; s < corpus.samples.length; s++) {
      const sample = corpus.samples[s];
      const pcm = audio.get(sample.id)!;
      for (let offset = 0; offset < variants.length; offset++) {
        const variant = variants[(offset + s + repetition) % variants.length];
        const start = performance.now();
        const transcript = await invoke(variant, pcm);
        rows.push({
          sample: sample.id, ...variant, repetition: repetition + 1,
          seconds: (performance.now() - start) / 1000,
          audioSeconds: pcm.length / (SAMPLE_RATE * 2),
          reference: sample.text, transcript, score: wordErrors(sample.text, transcript),
        });
        console.log(`${repetition + 1}/${repeats} ${sample.id} · ${variant.model} · hints ${variant.hints ? "on" : "off"}`);
      }
    }
  }
  const summary = variants.map((variant) => {
    const selected = rows.filter((row) => row.model === variant.model && row.hints === variant.hints);
    const errors = selected.reduce((sum, row) => sum + row.score.errors, 0);
    const words = selected.reduce((sum, row) => sum + row.score.words, 0);
    return {
      ...variant, observations: selected.length, words, errors, wer: errors / words,
      medianSeconds: median(selected.map((row) => row.seconds)),
      medianRealtimeFactor: median(selected.map((row) => row.seconds / row.audioSeconds)),
      exactMatches: selected.filter((row) => row.score.errors === 0).length,
    };
  });
  const report = {
    createdAt: new Date().toISOString(), corpus: corpus.label, synthetic: corpus.synthetic, vocabulary,
    sampleCount: corpus.samples.length, repeats, warmupCalls: variants.length,
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, memoryGiB: totalmem() / 2 ** 30, node: process.version, whisper: (version.stdout || version.stderr).trim() },
    method: "Identical audio in all four conditions; rotated condition order; fresh whisper-cli per call; warmup excluded. WER lowercases and splits on non-letter/non-number characters. It ignores case/punctuation, not word substitutions. No transcript rewriting.",
    summary, rows,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const table = [
    "| Model | Hints | Word error rate | Median seconds | Exact matches |",
    "| --- | --- | ---: | ---: | ---: |",
    ...summary.map((s) => `| ${s.model} | ${s.hints ? "on" : "off"} | ${(s.wer * 100).toFixed(2)}% | ${s.medianSeconds.toFixed(3)} | ${s.exactMatches}/${s.observations} |`),
  ].join("\n");
  await writeFile(join(output, "summary.md"), `# ${corpus.label}\n\n${table}\n\n${report.method}\n\n${corpus.synthetic ? "Synthetic clean speech only. Not evidence about human accents, microphone quality, or noisy rooms." : "User-supplied recordings. Do not publish this report without reviewing its transcripts."}\n`, { mode: 0o600 });
  console.log("\n" + table + "\n\nReport: " + relative(root, join(output, "report.json")));
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
