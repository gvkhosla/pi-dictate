// Synthetic microphone for the real Pi TUI smoke test. Never loaded by the package manifest.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDictation } from "../src/index.ts";

export default function fixture(pi: ExtensionAPI) {
  installDictation(pi, {
    config: () => ({ sox: "synthetic", whisper: "synthetic", model: "synthetic", language: "en" }),
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
    transcribe: async (_pcm, _config, signal) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      signal.throwIfAborted();
      return "Synthetic dictation inserted.";
    },
  });
}
