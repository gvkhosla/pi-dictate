// Synthetic microphone for the real Pi TUI smoke test. Never loaded by the package manifest.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDictation } from "../src/index.ts";
import { SetupRequiredError } from "../src/configuration.ts";
import { prepareSetup } from "../src/setup.ts";
import { setTimeout as delay } from "node:timers/promises";

export default function fixture(pi: ExtensionAPI) {
  let ready = process.env.PI_DICTATE_TEST_ONBOARD !== "1";
  const config = () => {
    if (!ready) throw new SetupRequiredError({ root: "/synthetic", missing: ["SoX", "whisper.cpp", "small.en model"], downloadModel: true });
    return { sox: "synthetic", whisper: "synthetic", model: "synthetic", language: "en" };
  };
  installDictation(pi, {
    config,
    setup: (error, ctx, signal) => prepareSetup(error, ctx, signal, {
      config,
      install: async (_plan, signal, update) => {
        update("Downloading model · 25%");
        await delay(350, undefined, { signal });
        update("Downloading model · 75%");
        await delay(350, undefined, { signal });
        ready = true;
      },
    }),
    record: (_sox, onAudio) => {
      const closed = Promise.withResolvers<{ code: number; signal: null }>();
      let frame = 0;
      const recorder = {
        expectedClose: false, seconds: 0, level: 0, clipping: false, error: "Synthetic mic error", closed: closed.promise,
        async stop() { await this.cancel(); return Buffer.alloc(32000); },
        async cancel() { clearInterval(timer); this.expectedClose = true; closed.resolve({ code: 0, signal: null }); },
      };
      const timer = setInterval(() => {
        recorder.seconds += 0.1;
        recorder.level = [0.1, 0.3, 0.7, 1, 0.6, 0.4][frame++ % 6];
        onAudio();
      }, 100);
      return recorder;
    },
    transcribe: async (_pcm, config, signal) => {
      if (config.vocabulary !== "TypeScript, shadcn") throw new Error("Session vocabulary did not reach inference.");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      signal.throwIfAborted();
      return "Synthetic dictation inserted.";
    },
  });
}
