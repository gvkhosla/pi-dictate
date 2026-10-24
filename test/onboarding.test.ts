import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig, SetupRequiredError, type SetupPlan } from "../src/configuration.ts";
import { prepareSetup, runSetup, setupDescription, setupProgress } from "../src/setup.ts";
import { renderSetup } from "../src/widget.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dictate-onboard-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "models"));
  await mkdir(join(root, "scripts"));
  return {
    root, bin,
    executable: (name: string) => writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
    model: () => writeFile(join(root, "models/ggml-small.en.bin"), "fixture"),
    config: (env: NodeJS.ProcessEnv = {}) => getConfig({ root, env, platform: "darwin", searchPaths: [bin] }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function plan(root = "/fixture"): SetupPlan {
  return { root, missing: ["small.en model"], downloadModel: true, sox: "/fixture/sox", whisper: "/fixture/whisper" };
}
const readyConfig = { sox: "fake", whisper: "fake", model: "fake", language: "en" };

function ui(confirmed = true) {
  let input: ((data: string) => unknown) | undefined;
  let widget: unknown;
  let confirmations = 0;
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      confirm: async (_title: string, message: string) => { confirmations++; assert.match(message, /488 MB/); return confirmed; },
      notify: (message: string) => notices.push(message),
      setWidget: (_key: string, value: unknown) => { widget = value; },
      onTerminalInput: (fn: typeof input) => { input = fn; return () => { input = undefined; }; },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices, input: (data: string) => input?.(data), get confirmations() { return confirmations; }, get widget() { return widget; } };
}

test("configuration inspection reports only missing pieces and does no setup", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.config(), /Install Homebrew/);
    await f.executable("brew");
    assert.throws(() => f.config(), (error) => {
      assert.ok(error instanceof SetupRequiredError);
      assert.deepEqual(error.plan.missing, ["SoX", "whisper.cpp", "small.en model"]);
      assert.equal(error.plan.brew, join(f.bin, "brew"));
      return true;
    });
    await f.executable("sox"); await f.executable("whisper-cli");
    assert.throws(() => f.config(), (error) => {
      assert.ok(error instanceof SetupRequiredError);
      assert.deepEqual(error.plan.missing, ["small.en model"]);
      return true;
    });
    await f.model();
    assert.equal(f.config().model, join(f.root, "models/ggml-small.en.bin"));
  } finally { await f.cleanup(); }
});

test("custom overrides are respected, invalid ones are never auto-replaced", async () => {
  const f = await fixture();
  try {
    await f.executable("sox"); await f.executable("whisper-cli"); await f.executable("brew");
    assert.throws(() => f.config({ PI_DICTATE_MODEL: join(f.root, "absent.bin") }), /Fix PI_DICTATE_MODEL/);
    assert.throws(() => f.config({ PI_DICTATE_SOX: "/missing/sox" }), /setup will not replace/);
    assert.throws(() => f.config({ PI_DICTATE_MODEL: f.root }), /not a readable file/);
    const model = join(f.root, "custom.bin"); await writeFile(model, "custom fixture");
    assert.equal(f.config({ PI_DICTATE_MODEL: model }).model, model);
    await rm(join(f.bin, "whisper-cli"));
    assert.throws(() => f.config({ PI_DICTATE_MODEL: model }), (error) => {
      assert.ok(error instanceof SetupRequiredError);
      assert.equal(error.plan.downloadModel, false);
      assert.deepEqual(error.plan.missing, ["whisper.cpp"]);
      return true;
    });
    assert.throws(() => getConfig({ platform: "linux" }), /macOS only/);
  } finally { await f.cleanup(); }
});

test("declining setup performs no installs and does not show progress", async () => {
  const h = ui(false);
  let installs = 0;
  const result = await prepareSetup(new SetupRequiredError(plan()), h.ctx, new AbortController().signal, {
    install: async () => { installs++; }, config: () => readyConfig,
  });
  assert.equal(result, undefined);
  assert.equal(installs, 0);
  assert.equal(h.confirmations, 1);
  assert.equal(h.widget, undefined);
});

test("accepted setup reports progress, blocks Enter, then verifies configuration", async () => {
  const h = ui();
  let checked = false;
  const result = await prepareSetup(new SetupRequiredError(plan()), h.ctx, new AbortController().signal, {
    install: async (_plan, _signal, update) => {
      assert.ok(h.widget);
      assert.deepEqual(h.input("\r"), { consume: true });
      assert.equal(h.input("x"), undefined);
      update("Downloading model · 42.0%");
    },
    config: () => { checked = true; return readyConfig; },
  });
  assert.equal(result, readyConfig);
  assert.equal(checked, true);
  assert.equal(h.widget, undefined);
  assert.equal(h.input("\r"), undefined);
  assert.match(h.notices[0], /Recording now/);
});

test("Escape aborts installation, cleans UI, and never returns a recording config", async () => {
  const h = ui();
  const started = Promise.withResolvers<void>();
  const work = prepareSetup(new SetupRequiredError(plan()), h.ctx, new AbortController().signal, {
    install: async (_plan, signal) => {
      started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, config: () => { assert.fail("must not start after cancellation"); },
  });
  await started.promise;
  assert.deepEqual(h.input("\u001b"), { consume: true });
  assert.equal(await work, undefined);
  assert.equal(h.widget, undefined);
  assert.match(h.notices[0], /cancelled/);
});

test("setup failures and unsuccessful readiness checks clean up without recording", async () => {
  for (const failInstall of [true, false]) {
    const h = ui();
    await assert.rejects(prepareSetup(new SetupRequiredError(plan()), h.ctx, new AbortController().signal, {
      install: async () => { if (failInstall) throw new Error("network unavailable"); },
      config: () => { throw new Error("still not ready"); },
    }), failInstall ? /network unavailable/ : /still not ready/);
    assert.equal(h.widget, undefined);
    assert.equal(h.input("\r"), undefined);
  }
});

test("unrelated configuration errors and pre-aborted setup never ask for consent", async () => {
  const h = ui();
  await assert.rejects(prepareSetup(new Error("bad custom path"), h.ctx, new AbortController().signal), /bad custom path/);
  await assert.rejects(prepareSetup(new SetupRequiredError(plan()), h.ctx, AbortSignal.abort()), /abort/i);
  assert.equal(h.confirmations, 0);
});

test("setup text discloses installation, microphone activation, and download progress", () => {
  const text = setupDescription({ ...plan(), missing: ["SoX", "whisper.cpp", "small.en model"] });
  assert.match(text, /Homebrew/); assert.match(text, /488 MB/); assert.match(text, /microphone will open/);
  assert.equal(setupProgress("########  42.1%\r"), "Downloading model · 42.1%");
  assert.equal(setupProgress("PI_DICTATE_PROGRESS=Verifying model checksum…"), "Verifying model checksum…");
  assert.equal(setupProgress("ordinary brew output"), undefined);
  assert.equal(setupProgress("999%"), undefined);
  for (const width of [0, 20, 40, 80]) {
    for (const line of renderSetup("Downloading model · 42.1%", width, { fg: (_key, value) => value })) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("installer streams split progress and requests dependency-only mode when appropriate", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "scripts/setup.sh"), 'printf "%s" "$*" > args\nprintf "PI_DICTATE_PROGRESS=Installing "\nprintf "SoX…\\n"\nprintf "### 42.0%%\\r" >&2\n');
    const messages: string[] = [];
    await runSetup({ ...plan(f.root), downloadModel: false }, new AbortController().signal, (message) => messages.push(message));
    assert.equal(await readFile(join(f.root, "args"), "utf8"), "small.en --dependencies-only");
    assert.ok(messages.includes("Installing SoX…"));
    assert.ok(messages.includes("Downloading model · 42.0%"));
  } finally { await f.cleanup(); }
});

test("installer cancellation terminates child processes, not just the shell", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "scripts/setup.sh"), 'trap "wait; exit 143" TERM\nsleep 30 &\necho $! > child.pid\nwait\n');
    const abort = new AbortController();
    const work = runSetup(plan(f.root), abort.signal, () => {});
    const rejected = assert.rejects(work, /abort/i);
    let pid = 0;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(join(f.root, "child.pid"), "utf8")); break; } catch { await delay(10); }
    }
    abort.abort();
    await rejected;
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await f.cleanup(); }
});
