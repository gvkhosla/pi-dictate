import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isClipping } from "../src/backend.ts";
import { renderDictation } from "../src/widget.ts";

test("clipping requires sustained near-full-scale samples, not one isolated peak", () => {
  assert.equal(isClipping(Buffer.alloc(0)), false);
  assert.equal(isClipping(Buffer.alloc(1)), false);
  const pcm = Buffer.alloc(4000);
  pcm.writeInt16LE(32767, 0);
  assert.equal(isClipping(pcm), false);
  for (let i = 0; i < 20; i++) pcm.writeInt16LE(i % 2 ? -32768 : 32767, i * 2);
  assert.equal(isClipping(pcm), true);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(16000, i);
  assert.equal(isClipping(pcm), false);
});

test("quiet and clipping warnings remain actionable without hiding controls or meter", () => {
  const theme = { fg: (_color: unknown, text: string) => text };
  for (const warning of ["quiet", "clipping"] as const) {
    for (const width of [20, 40, 80]) {
      const lines = renderDictation({ phase: "recording", seconds: 8, levels: [0, 0.3, 0.5, 1], warning }, width, theme);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      const text = lines.join("\n");
      assert.match(text, /Enter/);
      assert.match(text, /Esc/);
      assert.match(text, warning === "quiet" ? /Quiet.*check/ : /Clipping.*lower/);
    }
  }
  const lines = renderDictation({ phase: "transcribing", seconds: 8, levels: [], warning: "quiet" }, 80, theme);
  assert.doesNotMatch(lines.join("\n"), /Quiet/);
});
