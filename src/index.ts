import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getConfig, MAX_SECONDS, Recorder, transcribe, type Config } from "./backend.ts";
import { renderDictation, type DictationView } from "./widget.ts";
import { prepareSetup } from "./setup.ts";
import { normalizeVocabulary } from "./configuration.ts";

type Capture = Pick<Recorder, "closed" | "seconds" | "level" | "clipping" | "expectedClose" | "error" | "stop" | "cancel">;
export interface Dependencies {
  config: () => Config;
  setup?: (error: unknown, ctx: ExtensionContext, signal: AbortSignal) => Promise<Config | undefined>;
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
  // undefined inherits the environment; an empty string explicitly disables hints.
  let sessionVocabulary: string | undefined;
  const withVocabulary = (config: Config): Config => sessionVocabulary === undefined
    ? config : { ...config, vocabulary: normalizeVocabulary(sessionVocabulary) };
  let preparing: { abort: AbortController; done?: Promise<void> } | undefined;

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
    if (preparing) {
      const preparation = preparing;
      preparation.abort.abort();
      await preparation.done;
    }
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

  const startRecording = async (ctx: ExtensionContext, config: Config) => {
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

  const start = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Dictation requires Pi's interactive terminal UI.", "warning");
      return;
    }
    if (active || preparing) return;
    const preparation: { abort: AbortController; done?: Promise<void> } = { abort: new AbortController() };
    preparing = preparation;
    preparation.done = (async () => {
      try {
        let config: Config | undefined;
        try { config = dependencies.config(); } catch (error) {
          if (!dependencies.setup) throw error;
          config = await dependencies.setup(error, ctx, preparation.abort.signal);
        }
        if (!config || preparation.abort.signal.aborted) return;
        await startRecording(ctx, withVocabulary(config));
      } catch (error) {
        if (!preparation.abort.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        if (preparing === preparation) preparing = undefined;
      }
    })();
    await preparation.done;
  };

  pi.registerCommand("talk", {
    description: "Start local dictation; Enter transcribes into your prompt, Esc cancels",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "cancel") { await cancel(); return; }
      if (action === "vocab" || action.startsWith("vocab ")) {
        if (active || preparing) { ctx.ui.notify("Finish or cancel dictation before changing vocabulary.", "warning"); return; }
        const terms = action.slice(5).trim();
        if (!terms) {
          ctx.ui.notify("Use /talk vocab TypeScript, shadcn, Vitest (max 400 characters). Use /talk vocab off to disable or /talk vocab reset to use the environment default.", "info");
          return;
        }
        try {
          if (terms === "reset") sessionVocabulary = undefined;
          else sessionVocabulary = terms === "off" ? "" : normalizeVocabulary(terms) ?? "";
          ctx.ui.notify(terms === "reset" ? "Vocabulary reset to the environment default." : sessionVocabulary ? "Vocabulary enabled for this session. Hints guide recognition; they do not rewrite your transcript." : "Vocabulary disabled for this session.", "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        return;
      }
      if (action === "status") {
        try {
          const config = withVocabulary(dependencies.config());
          ctx.ui.notify(`Local dictation ready · /talk to record · Enter to transcribe · ${config.language}\nModel: ${config.model}\nVocabulary: ${config.vocabulary ? "enabled" : "off"}`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        return;
      }
      if (action) { ctx.ui.notify("Use /talk, /talk cancel, /talk status, or /talk vocab <terms>.", "warning"); return; }
      await start(ctx);
    },
  });
  pi.on("session_shutdown", async () => { sessionVocabulary = undefined; await cancel(); });
}

export default function dictate(pi: ExtensionAPI): void {
  installDictation(pi, { config: getConfig, setup: prepareSetup, record: (sox, onAudio) => new Recorder(sox, onAudio), transcribe });
}
