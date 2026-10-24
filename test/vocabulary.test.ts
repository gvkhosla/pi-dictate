import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVocabulary } from "../src/configuration.ts";
import { words, wordErrors, median } from "../scripts/benchmark-metrics.ts";

test("vocabulary is opt-in, bounded, and normalized without rewriting terms", () => {
  assert.equal(normalizeVocabulary(undefined), undefined);
  assert.equal(normalizeVocabulary(" \n "), undefined);
  assert.equal(normalizeVocabulary(" TypeScript,\n shadcn,\tpi-dictate\0 "), "TypeScript, shadcn, pi-dictate");
  assert.equal(normalizeVocabulary("x".repeat(400))?.length, 400);
  assert.throws(() => normalizeVocabulary("x".repeat(401)), /maximum 400/);
});

test("WER ignores case/punctuation but counts real substitutions, deletions and insertions", () => {
  assert.deepEqual(words("TypeScript, src/index.ts!"), ["typescript", "src", "index", "ts"]);
  assert.equal(wordErrors("Run TypeScript tests.", "run typescript tests").wer, 0);
  assert.equal(wordErrors("do not delete", "do delete").deletions, 1);
  assert.equal(wordErrors("run tests", "run more tests").insertions, 1);
  assert.equal(wordErrors("run tests", "run checks").substitutions, 1);
  assert.equal(wordErrors("a b c", "").deletions, 3);
  assert.equal(wordErrors("", "unexpected").wer, null);
  assert.equal(wordErrors("", "").wer, 0);
  assert.equal(wordErrors("a", "a b c").wer, 2);
});

test("latency median works without mutating the samples", () => {
  const input = [5, 1, 2];
  assert.equal(median(input), 2);
  assert.deepEqual(input, [5, 1, 2]);
  assert.equal(median([4, 2]), 3);
  assert.throws(() => median([]), /empty/);
});
