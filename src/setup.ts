import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getConfig, SetupRequiredError, type Config, type SetupPlan } from "./configuration.ts";
import { renderSetup } from "./widget.ts";

function plain(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

export function setupProgress(line: string): string | undefined {
  const clean = plain(line);
  if (clean.startsWith("PI_DICTATE_PROGRESS=")) return clean.slice("PI_DICTATE_PROGRESS=".length, 140);
  const percent = clean.match(/(?:^|\s)(\d+(?:\.\d+)?)%\s*$/)?.[1];
  if (percent && Number(percent) <= 100) return `Downloading model · ${percent}%`;
  return undefined;
}

/** Runs only after explicit consent. Terminates the entire installer process group on cancellation. */
export async function runSetup(plan: SetupPlan, signal: AbortSignal, onProgress: (message: string) => void): Promise<void> {
  signal.throwIfAborted();
  const args = [join(plan.root, "scripts/setup.sh"), "small.en"];
  if (!plan.downloadModel) args.push("--dependencies-only");
  const child = spawn("/bin/bash", args, {
    cwd: plan.root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [plan.brew ? dirname(plan.brew) : "", process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"),
      PI_DICTATE_SOX: plan.sox ?? "",
      PI_DICTATE_WHISPER: plan.whisper ?? "",
      NONINTERACTIVE: "1",
    },
  });
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let output = "";
  let spawnError: Error | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => resolve(code));
  });
  const kill = (how: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, how); } catch { /* Already exited. */ }
  };
  const abort = () => {
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 2000);
  };
  const capture = () => {
    let pending = "";
    return (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      const lines = (pending + chunk.toString()).split(/[\r\n]/);
      pending = (lines.pop() ?? "").slice(-4000);
      for (const line of lines) {
        const message = setupProgress(line);
        if (message) onProgress(message);
      }
    };
  };
  child.stdout.on("data", capture());
  child.stderr.on("data", capture());
  bounded.addEventListener("abort", abort, { once: true });
  if (bounded.aborted) abort();
  try {
    const code = await closed;
    if (bounded.aborted) kill("SIGKILL"); // Also reap descendants that detached their stdio.
    bounded.throwIfAborted();
    if (spawnError || code !== 0) {
      throw new Error(`Setup failed: ${spawnError?.message ?? (plain(output).slice(-1200) || `exit ${code}`)}. Run /talk to retry. Installed dependencies are not rolled back.`);
    }
  } finally {
    bounded.removeEventListener("abort", abort);
    clearTimeout(killTimer);
  }
}

export function setupDescription(plan: SetupPlan): string {
  const lines: string[] = [];
  const packages = plan.missing.filter((item) => item !== "small.en model");
  if (packages.length) lines.push(`• Install ${packages.join(" + ")} via Homebrew; may update dependencies.`);
  if (plan.downloadModel) lines.push("• Download small.en (~488 MB) from Hugging Face; verify checksum.");
  lines.push("", "The microphone will open when ready; allow macOS mic access.", "Esc cancels. Installed dependencies stay.", "No audio uploads.");
  return lines.join("\n");
}

/** Confirmation is separate from execution so declining never changes the machine. */
export async function prepareSetup(
  error: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal,
  dependencies: { install: typeof runSetup; config: () => Config } = { install: runSetup, config: getConfig },
): Promise<Config | undefined> {
  if (!(error instanceof SetupRequiredError)) throw error;
  if (ctx.mode !== "tui") throw new Error("Guided setup requires Pi's interactive terminal UI.");
  signal.throwIfAborted();
  const confirmed = await ctx.ui.confirm("Set up local dictation?", setupDescription(error.plan), { signal });
  signal.throwIfAborted();
  if (!confirmed) return undefined;

  const cancelled = new AbortController();
  const combined = AbortSignal.any([signal, cancelled.signal]);
  let message = "Starting setup…";
  let render = () => {};
  let unsubscribe: (() => void) | undefined;
  try {
    ctx.ui.setWidget("pi-dictate-setup", (tui, theme) => {
      render = () => tui.requestRender();
      return { render: (width) => renderSetup(message, width, theme), invalidate() {} };
    });
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, "escape")) { cancelled.abort(); return { consume: true }; }
      if (matchesKey(data, "enter")) return { consume: true };
      return undefined;
    });
    await dependencies.install(error.plan, combined, (progress) => {
      if (combined.aborted) return;
      message = progress;
      render();
    });
    combined.throwIfAborted();
    const config = dependencies.config(); // Verify readiness, never assume installer success.
    ctx.ui.notify("Setup complete. Recording now — allow microphone access if macOS asks.", "info");
    return config;
  } catch (cause) {
    if (cancelled.signal.aborted && !signal.aborted) {
      ctx.ui.notify("Setup cancelled. Run /talk when you're ready; installed dependencies are kept.", "info");
      return undefined;
    }
    throw cause;
  } finally {
    unsubscribe?.();
    ctx.ui.setWidget("pi-dictate-setup", undefined);
  }
}
