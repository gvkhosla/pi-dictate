import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getConfig, MAX_SECONDS, Recorder, transcribe, type Config } from "./backend.ts";
import { renderDictation, type DictationView } from "./widget.ts";

type Capture = Pick<Recorder, "closed" | "seconds" | "level" | "clipping" | "expectedClose" | "error" | "stop" | "cancel">;
export interface Dependencies {
  config: () => Config;
  record: (sox: string, onAudio: () => void) => Capture;
  transcribe: typeof transcribe;
}
interface Job {
  ctx: ExtensionContext;
  config: Config;
  view: DictationView;
  abort: AbortController;
  recorder?: Capture;
  timer?: ReturnType<typeof setInterval>;
  unsubscribe?: () => void;
  render: () => void;
  work?: Promise<void>;
  cancellation?: Promise<void>;
}

export function appendTranscript(draft: string, transcript: string): string {
  return draft + (draft && !/\s$/.test(draft) ? " " : "") + transcript;
}

export function installDictation(pi: ExtensionAPI, dependencies: Dependencies): void {
  let active: Job | undefined;

  const finish = (job: Job) => {
    clearInterval(job.timer);
    job.unsubscribe?.();
    job.unsubscribe = undefined;
    if (active === job) {
      active = undefined;
      job.ctx.ui.setWidget("pi-dictate", undefined);
    }
  };

  const fail = async (job: Job, error: unknown) => {
    if (active === job && !job.abort.signal.aborted) {
      job.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    await job.recorder?.cancel();
    finish(job);
  };

  const cancel = async () => {
    const job = active;
    if (!job) return;
    if (job.cancellation) return job.cancellation;
    job.view.phase = "cancelling";
    job.abort.abort();
    clearInterval(job.timer);
    job.render();
    job.cancellation = (async () => {
      await Promise.allSettled([job.recorder?.cancel(), job.work]);
      finish(job);
    })();
    return job.cancellation;
  };

  const stop = (job: Job) => {
    if (job.view.phase !== "starting" && job.view.phase !== "recording") return;
    job.view.phase = "stopping";
    clearInterval(job.timer);
    job.render();
    job.work = (async () => {
      try {
        const pcm = await job.recorder!.stop();
        job.abort.signal.throwIfAborted();
        job.view.phase = "transcribing";
        job.render();
        const text = await dependencies.transcribe(pcm, job.config, job.abort.signal);
        if (active !== job || job.abort.signal.aborted) return;
        // Read the CURRENT draft: preserve typing done while transcription was running.
        job.ctx.ui.setEditorText(appendTranscript(job.ctx.ui.getEditorText(), text));
        finish(job);
      } catch (error) {
        await fail(job, error);
      }
    })();
  };

  const start = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Dictation requires Pi's interactive terminal UI.", "warning");
      return;
    }
    if (active) return;
    let config: Config;
    try { config = dependencies.config(); } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    const job: Job = {
      ctx, config, abort: new AbortController(), render: () => {},
      view: { phase: "starting", seconds: 0, levels: Array(12).fill(0) },
    };
    active = job;
    const openedAt = Date.now();
    let lastAudioAt = openedAt;
    let lastAudibleAt = openedAt;
    let clippingUntil = 0;
    let peak = 0;
    try {
      ctx.ui.setWidget("pi-dictate", (tui, theme) => {
        job.render = () => tui.requestRender();
        return {
          render: (width) => renderDictation(job.view, width, theme),
          invalidate() {},
        };
      });
      job.unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (active !== job) return undefined;
        if (matchesKey(data, "escape")) {
          void cancel();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          // Consume Enter through inference too: never submit a partial draft.
          // finish() removes this listener, restoring normal Enter-to-send.
          stop(job);
          return { consume: true };
        }
        return undefined;
      });
      job.recorder = dependencies.record(config.sox, () => {
        lastAudioAt = Date.now();
        if (job.view.phase === "starting") job.view.phase = "recording";
        const level = job.recorder?.level ?? 0;
        peak = Math.max(peak, level);
        if (level > 0) lastAudibleAt = lastAudioAt;
        if (job.recorder?.clipping) clippingUntil = lastAudioAt + 1000;
      });
      job.recorder.closed.then(() => {
        if (active === job && !job.recorder!.expectedClose) {
          job.view.phase = "stopping";
          clearInterval(job.timer);
          job.work = fail(job, new Error(job.recorder!.error));
        }
      });
      job.timer = setInterval(() => {
        if (active !== job) return;
        const now = Date.now();
        job.view.seconds = job.recorder!.seconds;
        job.view.warning = now < clippingUntil ? "clipping" : now - lastAudibleAt >= 3000 ? "quiet" : undefined;
        job.view.levels.push(peak);
        job.view.levels.shift();
        peak = 0;
        job.render();
        if (now - lastAudioAt >= 15_000) {
          clearInterval(job.timer);
          job.view.phase = "stopping";
          job.work = fail(job, new Error("No audio from microphone. Allow your terminal in System Settings → Privacy & Security → Microphone, then retry."));
        } else if (job.view.seconds >= MAX_SECONDS || now - openedAt >= MAX_SECONDS * 1000) {
          stop(job);
        }
      }, 100);
    } catch (error) { await fail(job, error); }
  };

  pi.registerCommand("talk", {
    description: "Start local dictation; Enter transcribes into your prompt, Esc cancels",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "cancel") { await cancel(); return; }
      if (action === "status") {
        try {
          const config = dependencies.config();
          ctx.ui.notify(`Local dictation ready · /talk to record · Enter to transcribe · ${config.language}\nModel: ${config.model}`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        return;
      }
      if (action) { ctx.ui.notify("Use /talk, /talk cancel, or /talk status.", "warning"); return; }
      await start(ctx);
    },
  });
  pi.on("session_shutdown", async () => { await cancel(); });
}

export default function dictate(pi: ExtensionAPI): void {
  installDictation(pi, { config: getConfig, record: (sox, onAudio) => new Recorder(sox, onAudio), transcribe });
}
