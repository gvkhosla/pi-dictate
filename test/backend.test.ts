import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Recorder, cleanTranscript, meterLevel, rms, transcribe, wav } from "../src/backend.ts";

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "dictate-test-"));
  const executable = join(directory, "fake-process.cjs");
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { directory, executable, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const pcm = Buffer.alloc(32000);
for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000 * Math.sin(i / 20), i);

test("PCM measurements and WAV encoding are correct, including odd chunks", () => {
  assert.equal(rms(Buffer.alloc(200)), 0);
  assert.equal(rms(Buffer.alloc(1)), 0);
  assert.ok(rms(pcm) > 0.1);
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(1), 1);
  assert.ok(meterLevel(0.1) > meterLevel(0.01));
  const encoded = wav(Buffer.concat([pcm, Buffer.from([1])]));
  assert.equal(encoded.toString("ascii", 0, 4), "RIFF");
  assert.equal(encoded.readUInt32LE(4), 36 + pcm.length);
  assert.equal(encoded.readUInt32LE(24), 16000);
  assert.equal(encoded.readUInt32LE(40), pcm.length);
  assert.deepEqual(encoded.subarray(44), pcm);
});

test("transcript cleanup removes terminal control codes, not ordinary content", () => {
  assert.equal(cleanTranscript("\x1b[31mHello\x1b[0m\n world\x00 [BLANK_AUDIO]"), "Hello world");
  assert.equal(cleanTranscript("[Music] [SILENCE]"), "");
  assert.equal(cleanTranscript("Use [myFunction] in src/index.ts."), "Use [myFunction] in src/index.ts.");
});

test("recorder collects real subprocess PCM, finalizes on stop, and reports levels", async () => {
  const f = await fixture(`
const pcm = Buffer.alloc(32000); for (let i=0;i<pcm.length;i+=2) pcm.writeInt16LE(8000*Math.sin(i/20),i);
process.on('SIGINT', () => process.exit(0));
setTimeout(() => process.stdout.write(pcm), 20); setInterval(() => {}, 1000);
`);
  let capture: Recorder | undefined;
  try {
    const ready = Promise.withResolvers<void>();
    capture = new Recorder(f.executable, () => ready.resolve());
    await ready.promise;
    assert.ok(capture.level > 0);
    assert.ok(capture.seconds > 0);
    const audio = await capture.stop();
    assert.deepEqual(audio, pcm);
    assert.equal(capture.expectedClose, true);
  } finally { await capture?.cancel(); await f.cleanup(); }
});

test("silent recording is rejected without invoking Whisper", async () => {
  const f = await fixture(`process.on('SIGINT',()=>process.exit(0)); setTimeout(()=>process.stdout.write(Buffer.alloc(32000)),20); setInterval(()=>{},1000);`);
  let capture: Recorder | undefined;
  try {
    const ready = Promise.withResolvers<void>();
    capture = new Recorder(f.executable, () => ready.resolve());
    await ready.promise;
    await assert.rejects(capture.stop(), /No audible speech/);
  } finally { await capture?.cancel(); await f.cleanup(); }
});

test("missing recorder binary settles its lifecycle instead of hanging", async () => {
  const capture = new Recorder("/nonexistent/pi-dictate-recorder", () => {});
  const result = await capture.closed;
  assert.equal((result.error as NodeJS.ErrnoException)?.code, "ENOENT");
  await capture.cancel();
});

test("Whisper success uses a private temporary directory and removes audio/output", async () => {
  const f = await fixture(`
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv; const out = args[args.indexOf('-of')+1]; const input = args[args.indexOf('-f')+1];
if ((fs.statSync(path.dirname(input)).mode & 0o077) !== 0) process.exit(3);
if ((fs.statSync(input).mode & 0o077) !== 0) process.exit(4);
fs.writeFileSync(path.join(__dirname,'used-directory'), path.dirname(input));
fs.writeFileSync(out+'.txt', '  test transcription.\\n');
`);
  try {
    const result = await transcribe(pcm, { whisper: f.executable, model: "unused", sox: "unused", language: "en" }, new AbortController().signal);
    assert.equal(result, "test transcription.");
    const directory = await readFile(join(f.directory, "used-directory"), "utf8");
    await assert.rejects(access(directory));
  } finally { await f.cleanup(); }
});

test("vocabulary is passed as one optional Whisper prompt argument, not a rewrite step", async () => {
  const f = await fixture(`
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname,'args.json'), JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-of')+1]+'.txt', 'recognized words');
`);
  try {
    const base = { whisper: f.executable, model: "unused", sox: "unused", language: "en" };
    await transcribe(pcm, base, new AbortController().signal);
    assert.ok(!(JSON.parse(await readFile(join(f.directory, "args.json"), "utf8")) as string[]).includes("--prompt"));
    const result = await transcribe(pcm, { ...base, vocabulary: " TypeScript, shadcn; pi-dictate " }, new AbortController().signal);
    const args = JSON.parse(await readFile(join(f.directory, "args.json"), "utf8")) as string[];
    assert.equal(args[args.indexOf("--prompt") + 1], "Technical vocabulary: TypeScript, shadcn; pi-dictate");
    assert.equal(args.filter((arg) => arg === "--prompt").length, 1);
    assert.equal(result, "recognized words");
    await assert.rejects(transcribe(pcm, { ...base, vocabulary: "x".repeat(401) }, new AbortController().signal), /maximum 400/);
  } finally { await f.cleanup(); }
});

test("Whisper failure removes temporary files and includes useful diagnostic", async () => {
  const f = await fixture(`
const fs = require('node:fs'); const path = require('node:path');
const input=process.argv[process.argv.indexOf('-f')+1];
fs.writeFileSync(path.join(__dirname,'used-directory'),path.dirname(input));
process.stderr.write('invalid model'); process.exit(1);
`);
  try {
    await assert.rejects(transcribe(pcm, { whisper: f.executable, model: "bad", sox: "unused", language: "en" }, new AbortController().signal), /invalid model/);
    const directory = await readFile(join(f.directory, "used-directory"), "utf8");
    await assert.rejects(access(directory));
  } finally { await f.cleanup(); }
});

test("cancelling Whisper kills even a stubborn process and deletes its files", async () => {
  const f = await fixture(`
const fs = require('node:fs'); const path = require('node:path');
process.on('SIGTERM',()=>{});
const input=process.argv[process.argv.indexOf('-f')+1];
fs.writeFileSync(path.join(__dirname,'used-directory'),path.dirname(input));
setInterval(()=>{},1000);
`);
  try {
    const abort = new AbortController();
    const work = transcribe(pcm, { whisper: f.executable, model: "unused", sox: "unused", language: "en" }, abort.signal);
    const rejected = assert.rejects(work, /abort/i);
    let directory = "";
    for (let i = 0; i < 100; i++) {
      try { directory = await readFile(join(f.directory, "used-directory"), "utf8"); break; } catch { await delay(10); }
    }
    abort.abort();
    await rejected;
    assert.ok(directory);
    await assert.rejects(access(directory));
  } finally { await f.cleanup(); }
});

test("pre-aborted inference never launches a child", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(transcribe(pcm, { whisper: "nonexistent", model: "unused", sox: "unused", language: "en" }, abort.signal), /abort/i);
});
