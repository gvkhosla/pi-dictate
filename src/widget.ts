import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface DictationView {
  phase: "starting" | "recording" | "stopping" | "transcribing" | "cancelling";
  seconds: number;
  levels: number[];
  warning?: "quiet" | "clipping";
}

export function elapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function waveform(levels: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  return levels.map((v) => bars[Math.round(Math.max(0, Math.min(1, v)) * 7)]).join("");
}

/** Stateless rendering: theme changes and terminal resizes never reuse stale ANSI. */
export function renderDictation(view: DictationView, width: number, theme: Pick<Theme, "fg">): string[] {
  const narrow = width < 72;
  const hint = theme.fg("muted", narrow ? "Enter transcribe · Esc cancel" : "Enter transcribe · Esc cancel · local");
  let line: string;
  switch (view.phase) {
    case "recording": {
      const meter = waveform(view.levels.slice(narrow ? -6 : -12));
      const feedback = theme.fg("accent", meter);
      line = `${theme.fg("accent", "● Recording")}  ${feedback}  ${elapsed(view.seconds)}  ${hint}`;
      break;
    }
    case "starting":
      line = `${theme.fg("accent", "○ Opening microphone…")}  ${theme.fg("muted", "Esc cancel")}`;
      break;
    case "stopping":
      line = `${theme.fg("accent", "○ Stopping microphone…")}  ${theme.fg("muted", "Esc cancel")}`;
      break;
    case "transcribing":
      line = `${theme.fg("accent", narrow ? "○ Transcribing…" : "○ Transcribing locally…")}  ${theme.fg("muted", "mic off · Esc cancel")}`;
      break;
    case "cancelling":
      line = theme.fg("muted", "Cancelling dictation…");
      break;
  }
  let lines = [line];
  // Stack controls on narrow terminals so the live meter and cancel hint survive.
  if (narrow && view.phase === "recording") {
    const feedback = width >= 28 ? `  ${theme.fg("accent", waveform(view.levels.slice(-6)))}` : "";
    lines = [
      `${theme.fg("accent", "● Recording")} ${elapsed(view.seconds)}${feedback}`,
      theme.fg("muted", width < 28 ? "Enter stop / Esc" : "Enter transcribe · Esc cancel"),
    ];
  }
  if (view.phase === "recording" && view.warning) {
    const message = view.warning === "clipping"
      ? (width < 32 ? "Clipping: lower gain" : "Clipping — lower input volume")
      : (width < 32 ? "Quiet: check mic" : "Quiet mic — check Sound → Input");
    lines.push(theme.fg("warning", message));
  }
  return lines.map((row) => truncateToWidth(row, Math.max(0, width)));
}
