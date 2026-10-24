import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 120;
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;

export interface Config {
  sox: string;
  whisper: string;
  model: string;
  language: string;
}

function executable(name: string, override?: string): string {
  const paths = override ? [override] : [
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((p) => join(p, name)),
    `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`,
  ];
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); return path; } catch { /* next candidate */ }
  }
  throw new Error(`${name} not found. Run npm run setup in pi-dictate.`);
}

export function getConfig(): Config {
  if (process.platform !== "darwin") throw new Error("Local dictation currently supports macOS only.");
  const model = process.env.PI_DICTATE_MODEL ?? join(dirname(fileURLToPath(import.meta.url)), "../models/ggml-base.en.bin");
  try { accessSync(model, constants.R_OK); } catch {
    throw new Error("Whisper model missing. Run npm run setup in pi-dictate.");
  }
  return {
    sox: executable("sox", process.env.PI_DICTATE_SOX),
    whisper: executable("whisper-cli", process.env.PI_DICTATE_WHISPER),
    model,
    language: process.env.PI_DICTATE_LANGUAGE ?? "en",
  };
}

export function rms(pcm: Buffer): number {
  const count = Math.floor(pcm.length / 2);
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return Math.sqrt(sum / count);
}

export function isClipping(pcm: Buffer): boolean {
  const count = Math.floor(pcm.length / 2);
  if (!count) return false;
  let clipped = 0;
  for (let i = 0; i < count; i++) if (Math.abs(pcm.readInt16LE(i * 2)) >= 32440) clipped++;
  return clipped / count >= 0.01;
}

export function meterLevel(value: number): number {
  // Map -60..-6 dB to 0..1. This is microphone energy, not speech detection.
  return Math.max(0, Math.min(1, (20 * Math.log10(Math.max(value, 1e-8)) + 60) / 54));
}

export function wav(pcm: Buffer): Buffer {
  const data = pcm.subarray(0, pcm.length - (pcm.length % 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function cleanTranscript(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC)\]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim();
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
function observe(child: ChildProcessWithoutNullStreams): Promise<Exit> {
  return new Promise((resolve) => {
    let error: Error | undefined;
    child.once("error", (e) => { error = e; });
    child.once("close", (code, signal) => resolve({ code, signal, error }));
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<Exit>, signal: NodeJS.Signals): Promise<Exit> {
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  try { return await closed; } finally { clearTimeout(timer); }
}

/** Owns only the microphone process and bounded PCM buffer. No files or network. */
export class Recorder {
  readonly closed: Promise<Exit>;
  private child: ChildProcessWithoutNullStreams;
  private chunks: Buffer[] = [];
  private tail: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private stderr = "";
  private ending = false;
  private discarded = false;
  private stopping?: Promise<Exit>;
  level = 0;
  clipping = false;
  audibleSeconds = 0;

  constructor(sox: string, onAudio: () => void, spawnProcess = spawn) {
    this.child = spawnProcess(sox, [
      "-q", "--buffer", "2048", "-t", "coreaudio", "default",
      "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer",
      "-L", "-t", "raw", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.end();
    this.closed = observe(this.child);
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.discarded || this.bytes >= MAX_BYTES) return;
      const joined = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
      const count = Math.min(joined.length - (joined.length % 2), MAX_BYTES - this.bytes);
      this.tail = joined.subarray(count);
      if (!count) return;
      const data = joined.subarray(0, count);
      this.chunks.push(data);
      this.bytes += count;
      const energy = rms(data);
      this.level = meterLevel(energy);
      this.clipping = isClipping(data);
      if (energy > 0.001) this.audibleSeconds += count / (SAMPLE_RATE * 2);
      onAudio();
    });
  }

  get seconds(): number { return this.bytes / (SAMPLE_RATE * 2); }
  get expectedClose(): boolean { return this.ending; }
  get error(): string {
    const detail = cleanTranscript(this.stderr);
    return `Microphone stopped unexpectedly${detail ? `: ${detail}` : "."} Check your terminal's microphone permission and Sound → Input.`;
  }

  private close(): Promise<Exit> {
    this.ending = true;
    return this.stopping ??= stopChild(this.child, this.closed, "SIGINT");
  }

  async stop(): Promise<Buffer> {
    const result = await this.close();
    if (result.error || (result.code !== 0 && result.signal !== "SIGINT")) throw new Error(this.error);
    if (this.seconds < 0.3 || this.audibleSeconds < 0.15) {
      throw new Error("No audible speech captured. Check Sound → Input and try again.");
    }
    const resultBuffer = Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    return resultBuffer;
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    this.chunks = [];
    this.tail = Buffer.alloc(0);
    await this.close();
  }
}

/** Writes audio only inside a private directory, and waits for the child before deleting it. */
export async function transcribe(pcm: Buffer, config: Config, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-dictate-"));
  try {
    signal.throwIfAborted();
    const input = join(directory, "audio.wav");
    const output = join(directory, "transcript");
    await writeFile(input, wav(pcm), { mode: 0o600 });
    signal.throwIfAborted();
    const child = spawn(config.whisper, [
      "-m", config.model, "-f", input, "-l", config.language,
      "-otxt", "-of", output, "-nt", "-np", "-sns",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    child.stdout.resume(); // Transcript comes from the output file, never diagnostic stdout.
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-3000); });
    const closed = observe(child);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    let stopping: Promise<Exit> | undefined;
    const abort = () => { stopping ??= stopChild(child, closed, "SIGTERM"); };
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) abort();
    let result: Exit;
    try {
      result = await closed;
      if (stopping) await stopping;
    } finally { bounded.removeEventListener("abort", abort); }
    bounded.throwIfAborted();
    if (result.error || result.code !== 0) {
      throw new Error(`Local transcription failed: ${result.error?.message ?? (cleanTranscript(stderr) || `exit ${result.code}`)}`);
    }
    const text = cleanTranscript(await readFile(`${output}.txt`, "utf8"));
    signal.throwIfAborted();
    if (!text) throw new Error("No speech recognized. Try again a little closer to the microphone.");
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
