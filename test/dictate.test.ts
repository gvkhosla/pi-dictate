import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { appendTranscript, installDictation, type Dependencies } from "../src/index.ts";
import { renderDictation, elapsed, waveform, type DictationView } from "../src/widget.ts";

const theme = { fg: (_color: unknown, text: string) => text };
const config = { sox: "fake", whisper: "fake", model: "fake", language: "en" };
const tick = () => delay(0);

function harness(options: { transcribe?: Dependencies["transcribe"]; mode?: string; failConfig?: boolean; setup?: Dependencies["setup"]; vocabulary?: string } = {}) {
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  let shutdown: () => Promise<void>;
  let input: ((data: string) => unknown) | undefined;
  let editor = "existing draft";
  let widget: unknown;
  let records = 0;
  let transcriptions = 0;
  let captures: ReturnType<typeof capture>[] = [];
  const notices: string[] = [];
  const dependencies: Dependencies = {
    setup: options.setup,
    config: () => { if (options.failConfig) throw new Error("missing model"); return { ...config, vocabulary: options.vocabulary }; },
    record: (_sox, onAudio) => { records++; const rec = capture(onAudio); captures.push(rec); return rec; },
    transcribe: async (...args) => { transcriptions++; return options.transcribe ? options.transcribe(...args) : "dictated text"; },
  };
  function capture(onAudio: () => void) {
    const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    return {
      closed: completion.promise, expectedClose: false, seconds: 1, level: 0.5, clipping: false, error: "mic failed",
      audio: onAudio,
      async stop() { this.expectedClose = true; completion.resolve({ code: 0, signal: null }); return Buffer.alloc(32000); },
      async cancel() { this.expectedClose = true; completion.resolve({ code: 0, signal: null }); },
      crash() { completion.resolve({ code: 1, signal: null }); },
    };
  }
  const ctx = {
    mode: options.mode ?? "tui",
    ui: {
      notify: (message: string) => notices.push(message),
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      onTerminalInput: (fn: typeof input) => { input = fn; return () => { input = undefined; }; },
      setWidget: (_name: string, value: unknown) => {
        widget = value;
        if (typeof value === "function") widget = value({ requestRender() {} }, theme);
      },
    },
  } as unknown as ExtensionContext;
  installDictation({
    registerShortcut: () => assert.fail("Dictation must not register a keyboard shortcut"),
    registerCommand: (name: string, value: { handler: typeof command }) => { assert.equal(name, "talk"); command = value.handler; },
    on: (event: string, handler: typeof shutdown) => { assert.equal(event, "session_shutdown"); shutdown = handler; },
  } as unknown as ExtensionAPI, dependencies);
  return {
    // Simulate /talk when idle and Enter while recording or transcribing.
    toggle: async () => { if (input) input("\r"); else await command("", ctx); },
    command: (s: string) => command(s, ctx),
    shutdown: () => shutdown(), input: (s: string) => input?.(s),
    draft: (s: string) => { editor = s; },
    get editor() { return editor; }, get widget() { return widget; },
    get records() { return records; }, get transcriptions() { return transcriptions; },
    get rec() { return captures.at(-1)!; }, notices,
    get listening() { return !!input; },
  };
}

test("append preserves existing prompt including trailing whitespace", () => {
  assert.equal(appendTranscript("", "hello"), "hello");
  assert.equal(appendTranscript("draft", "hello"), "draft hello");
  assert.equal(appendTranscript("draft\n", "hello"), "draft\nhello");
});

test("waveform reflects real levels, clock and every UI state fit narrow terminals", () => {
  assert.equal(waveform([0, 0.5, 1]), "▁▅█");
  assert.equal(elapsed(72.9), "1:12");
  for (const phase of ["starting", "recording", "stopping", "transcribing", "cancelling"] as const) {
    const view: DictationView = { phase, levels: [0, 0.2, 0.5, 1, 0.5, 0.2], seconds: 12 };
    for (const width of [0, 1, 20, 40, 60, 70, 80, 120]) {
      const lines = renderDictation(view, width, theme);
      assert.ok(lines.length >= 1 && lines.length <= 2);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${phase} at ${width}: ${line}`);
    }
  }
});

test("/talk starts exactly one capture and Enter appends the current draft", async () => {
  const deferred = Promise.withResolvers<string>();
  const h = harness({ transcribe: () => deferred.promise });
  try {
    await h.toggle();
    assert.ok(h.widget);
    await h.command(""); // Repeating /talk must not stop or open another mic.
    assert.equal(h.records, 1);
    assert.equal(h.transcriptions, 0);
    h.rec.audio();
    await h.toggle();
    await tick();
    await h.toggle(); // During transcription this is not another recording.
    assert.equal(h.records, 1);
    assert.equal(h.transcriptions, 1);
    h.draft("edited while transcribing");
    deferred.resolve("new words");
    await tick();
    assert.equal(h.editor, "edited while transcribing new words");
    assert.equal(h.widget, undefined);
    assert.equal(h.listening, false);
  } finally { deferred.resolve("done"); await h.shutdown(); }
});

test("Enter transcribes into the prompt, consumes repeated presses, then restores normal submit", async () => {
  const deferred = Promise.withResolvers<string>();
  const h = harness({ transcribe: () => deferred.promise });
  try {
    assert.equal(h.input("\r"), undefined); // Idle Enter belongs to Pi.
    await h.toggle();
    h.rec.audio();
    assert.deepEqual(h.input("\r"), { consume: true });
    assert.deepEqual(h.input("\r"), { consume: true }); // Still stopping.
    await tick();
    assert.deepEqual(h.input("\r"), { consume: true }); // Still transcribing.
    assert.equal(h.editor, "existing draft");
    assert.equal(h.transcriptions, 1);
    deferred.resolve("new words");
    await tick();
    assert.equal(h.editor, "existing draft new words");
    assert.equal(h.input("\r"), undefined); // User can now submit normally.
    assert.equal(h.listening, false);
  } finally { deferred.resolve("done"); await h.shutdown(); }
});

test("Enter works while opening the mic and modified Enter stays with the editor", async () => {
  const h = harness();
  try {
    await h.toggle();
    assert.equal(h.input("\u001b[13;2u"), undefined); // Kitty Shift+Enter.
    assert.equal(h.transcriptions, 0);
    assert.deepEqual(h.input("\u001b[13u"), { consume: true }); // Kitty Enter.
    await tick();
    assert.equal(h.editor, "existing draft dictated text");
    assert.equal(h.widget, undefined);
  } finally { await h.shutdown(); }
});

test("Escape cancels capture without transcription and leaves draft untouched", async () => {
  const h = harness();
  await h.toggle();
  assert.equal(h.input("x"), undefined);
  assert.deepEqual(h.input("\u001b"), { consume: true });
  await tick();
  assert.equal(h.editor, "existing draft");
  assert.equal(h.transcriptions, 0);
  assert.equal(h.widget, undefined);
  assert.equal(h.listening, false);
  await h.shutdown();
});

test("cancellation suppresses late inference results and allows retry", async () => {
  const deferred = Promise.withResolvers<string>();
  const h = harness({ transcribe: () => deferred.promise });
  await h.toggle(); await h.toggle(); await tick();
  const cancellation = h.command("cancel");
  deferred.resolve("must never appear");
  await cancellation;
  assert.equal(h.editor, "existing draft");
  assert.equal(h.widget, undefined);
  assert.deepEqual(h.notices, []);
  await h.toggle();
  assert.equal(h.records, 2);
  await h.shutdown();
});

test("shutdown aborts inference, cleans listeners and never inserts into another session", async () => {
  const h = harness({ transcribe: (_pcm, _config, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  await h.toggle(); await h.toggle(); await tick();
  await h.shutdown();
  assert.equal(h.editor, "existing draft");
  assert.equal(h.widget, undefined);
  assert.equal(h.listening, false);
  assert.deepEqual(h.notices, []);
});

test("transcription failure is recoverable without losing the prompt", async () => {
  const h = harness({ transcribe: async () => { throw new Error("inference failed"); } });
  await h.toggle(); await h.toggle(); await tick();
  assert.deepEqual(h.notices, ["inference failed"]);
  assert.equal(h.editor, "existing draft");
  assert.equal(h.widget, undefined);
  await h.toggle(); assert.equal(h.records, 2);
  await h.shutdown();
});

test("unexpected recorder exit cleans UI and shows actionable error", async () => {
  const h = harness();
  await h.toggle(); h.rec.crash(); await tick();
  assert.deepEqual(h.notices, ["mic failed"]);
  assert.equal(h.widget, undefined);
  assert.equal(h.transcriptions, 0);
  await h.shutdown();
});

test("mic health waits for sustained silence, clears on audio, and holds clipping briefly", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const h = harness();
  const render = () => (h.widget as { render: (width: number) => string[] }).render(80).join("\n");
  try {
    await h.command("");
    h.rec.level = 0;
    h.rec.audio();
    t.mock.timers.tick(2900);
    assert.doesNotMatch(render(), /Quiet/);
    t.mock.timers.tick(200);
    assert.match(render(), /Quiet mic/);
    h.rec.level = 0.6;
    h.rec.audio();
    t.mock.timers.tick(100);
    assert.doesNotMatch(render(), /Quiet/);
    h.rec.clipping = true;
    h.rec.audio();
    t.mock.timers.tick(100);
    assert.match(render(), /Clipping/);
    h.rec.clipping = false;
    h.rec.audio();
    t.mock.timers.tick(1100);
    assert.doesNotMatch(render(), /Clipping/);
  } finally { await h.shutdown(); t.mock.timers.reset(); }
});

test("first-run setup is single-flight and only records after successful preparation", async () => {
  const ready = Promise.withResolvers<typeof config | undefined>();
  let setups = 0;
  const h = harness({ failConfig: true, setup: async () => { setups++; return ready.promise; } });
  const starting = h.command("");
  await tick();
  await h.command("");
  assert.equal(setups, 1);
  assert.equal(h.records, 0);
  ready.resolve(config);
  await starting;
  assert.equal(h.records, 1);
  await h.shutdown();
});

test("declining setup leaves the draft intact and can be retried", async () => {
  let setups = 0;
  const h = harness({ failConfig: true, setup: async () => { setups++; return setups === 1 ? undefined : config; } });
  await h.command("");
  assert.equal(h.records, 0);
  assert.equal(h.editor, "existing draft");
  await h.command("");
  assert.equal(h.records, 1);
  await h.shutdown();
});

test("shutdown during setup suppresses even a late successful result", async () => {
  const ready = Promise.withResolvers<typeof config | undefined>();
  const h = harness({ failConfig: true, setup: () => ready.promise });
  const starting = h.command("");
  await tick();
  const shutdown = h.shutdown();
  ready.resolve(config);
  await Promise.all([starting, shutdown]);
  assert.equal(h.records, 0);
  assert.equal(h.widget, undefined);
  assert.deepEqual(h.notices, []);
});

test("status and ready configurations never invoke first-run setup", async () => {
  let setups = 0;
  const setup = async () => { setups++; return config; };
  const missing = harness({ failConfig: true, setup });
  await missing.command("status");
  assert.equal(setups, 0);
  const ready = harness({ setup });
  await ready.command("");
  assert.equal(setups, 0);
  assert.equal(ready.records, 1);
  await ready.shutdown();
});

test("session vocabulary can be set, disabled, and reset without opening the microphone", async () => {
  const seen: Array<string | undefined> = [];
  const h = harness({ vocabulary: "Prisma", transcribe: async (_pcm, config) => { seen.push(config.vocabulary); return "unchanged output"; } });
  try {
    await h.command("vocab TypeScript, shadcn");
    assert.equal(h.records, 0);
    await h.command("vocab " + "x".repeat(401)); // Bad edits preserve the old setting.
    assert.match(h.notices.at(-1)!, /maximum 400/);
    await h.toggle(); await h.toggle(); await tick();
    await h.command("vocab off");
    await h.toggle(); await h.toggle(); await tick();
    await h.command("vocab reset");
    await h.toggle(); await h.toggle(); await tick();
    assert.deepEqual(seen, ["TypeScript, shadcn", undefined, "Prisma"]);
    assert.equal(h.editor, "existing draft unchanged output unchanged output unchanged output");
    await h.command("vocab TypeScript");
    await h.shutdown();
    await h.toggle(); await h.toggle(); await tick();
    assert.equal(seen.at(-1), "Prisma"); // Session changes discard session-only hints.
  } finally { await h.shutdown(); }
});

test("vocabulary cannot change an in-flight dictation", async () => {
  const h = harness();
  try {
    await h.command("vocab");
    assert.equal(h.records, 0);
    await h.command("");
    await h.command("vocab TypeScript");
    assert.match(h.notices.at(-1)!, /Finish or cancel/);
  } finally { await h.shutdown(); }
});

test("noninteractive mode, missing model, and status never open the microphone", async () => {
  const rpc = harness({ mode: "rpc" });
  await rpc.toggle(); assert.equal(rpc.records, 0);
  assert.match(rpc.notices[0], /interactive/);
  const missing = harness({ failConfig: true });
  await missing.toggle(); assert.equal(missing.records, 0);
  assert.deepEqual(missing.notices, ["missing model"]);
  const status = harness();
  await status.command("status"); await status.command("unknown");
  assert.equal(status.records, 0);
  assert.match(status.notices[0], /ready/);
});
