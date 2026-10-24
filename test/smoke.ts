// Usage: node --experimental-strip-types test/smoke.ts sample.pcm
// Input: signed 16-bit little-endian, mono, 16 kHz PCM. Does not open the microphone.
import { readFile } from "node:fs/promises";
import { getConfig, transcribe } from "../src/backend.ts";
const path = process.argv[2];
if (!path) throw new Error("Supply a 16 kHz mono s16le PCM file.");
const start = performance.now();
const text = await transcribe(await readFile(path), getConfig(), new AbortController().signal);
console.log(JSON.stringify({ text, seconds: (performance.now() - start) / 1000 }));
