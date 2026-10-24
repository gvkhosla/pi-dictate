import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dictate-setup-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/setup.sh", import.meta.url), join(root, "scripts/setup.sh"));
  const scripts = {
    uname: "echo Darwin",
    sox: "exit 0",
    "whisper-cli": "exit 0",
    curl: 'echo called >> "$MOCK_DOWNLOADS"; while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf "fixture model" > "$1"; exit 0; fi; shift; done; exit 1',
    shasum: 'while IFS= read -r line; do printf "%s\\n" "$line" >> "$MOCK_CHECKS"; done; exit "${MOCK_SHA_FAIL:-0}"',
  };
  for (const [name, body] of Object.entries(scripts)) await writeFile(join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o700 });
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, MOCK_DOWNLOADS: join(root, "downloads"), MOCK_CHECKS: join(root, "checks") };
  return {
    root,
    run: (args: string[], extra = {}) => exec("/bin/bash", ["scripts/setup.sh", ...args], { cwd: root, env: { ...env, ...extra } }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("setup downloads the selected model, verifies its pinned hash, and is idempotent", async () => {
  const f = await fixture();
  try {
    for (const [name, sha] of [
      ["base.en", "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"],
      ["small.en", "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d"],
    ]) {
      const result = await f.run([name]);
      assert.match(result.stdout, /ready/);
      if (name === "base.en") assert.match(result.stdout, /PI_DICTATE_MODEL=/);
      assert.equal(await readFile(join(f.root, "models", "ggml-" + name + ".bin"), "utf8"), "fixture model");
      assert.ok((await readFile(join(f.root, "checks"), "utf8")).includes(sha));
      await f.run([name]);
    }
    assert.equal((await readFile(join(f.root, "downloads"), "utf8")).trim().split("\n").length, 2);
  } finally { await f.cleanup(); }
});

test("setup defaults to small.en without requiring an environment override", async () => {
  const f = await fixture();
  try {
    const result = await f.run([]);
    assert.match(result.stdout, /small.en model ready/);
    assert.doesNotMatch(result.stdout, /PI_DICTATE_MODEL=/);
    assert.deepEqual(await readdir(join(f.root, "models")), ["ggml-small.en.bin"]);
  } finally { await f.cleanup(); }
});

test("dependency-only setup never downloads a model and validates binary overrides", async () => {
  const f = await fixture();
  try {
    await f.run(["small.en", "--dependencies-only"]);
    await assert.rejects(readFile(join(f.root, "downloads")));
    await assert.rejects(readdir(join(f.root, "models")));
    await assert.rejects(f.run(["small.en", "--dependencies-only"], { PI_DICTATE_SOX: "/missing/sox" }), /Invalid SoX override/);
    await assert.rejects(f.run(["small.en", "--unknown"]), /Unknown setup option/);
  } finally { await f.cleanup(); }
});

test("setup rejects unknown models and cleans up failed checksum downloads", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run(["not-a-model"]), /Unknown model/);
    await assert.rejects(readFile(join(f.root, "downloads")));
    await assert.rejects(f.run(["base.en"], { MOCK_SHA_FAIL: "1" }));
    assert.deepEqual(await readdir(join(f.root, "models")), []);
  } finally { await f.cleanup(); }
});
