import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  sox: string;
  whisper: string;
  model: string;
  language: string;
  vocabulary?: string;
}

export function normalizeVocabulary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > 400) throw new Error("Vocabulary is too long (maximum 400 characters). Use a short list of names and technical terms.");
  return text || undefined;
}

export interface SetupPlan {
  root: string;
  missing: Array<"SoX" | "whisper.cpp" | "small.en model">;
  downloadModel: boolean;
  brew?: string;
  sox?: string;
  whisper?: string;
}

export class SetupRequiredError extends Error {
  readonly plan: SetupPlan;
  constructor(plan: SetupPlan) {
    super(`Missing ${plan.missing.join(", ")}. Run /talk for guided setup.`);
    this.name = "SetupRequiredError";
    this.plan = plan;
  }
}

function accessibleFile(path: string, mode: number): boolean {
  try { accessSync(path, mode); return statSync(path).isFile(); } catch { return false; }
}

function executable(name: string, override: string | undefined, searchPaths: string[]): string | undefined {
  if (override !== undefined) {
    if (!isAbsolute(override) || !accessibleFile(override, constants.X_OK)) {
      throw new Error(`Configured ${name} is not an executable file: ${override}. Fix its PI_DICTATE_* override; setup will not replace it.`);
    }
    return override;
  }
  const found = searchPaths.map((p) => join(p, name))
    .find((candidate) => accessibleFile(candidate, constants.X_OK));
  return found ? resolve(found) : undefined;
}

/** Checks only. Never downloads, installs, or opens a microphone. Injectable paths keep tests offline. */
export function getConfig(options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  searchPaths?: string[];
} = {}): Config {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Local dictation currently supports macOS only.");
  const vocabulary = normalizeVocabulary(env.PI_DICTATE_VOCABULARY);
  const searchPaths = options.searchPaths ?? [...(env.PATH ?? "").split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  const sox = executable("sox", env.PI_DICTATE_SOX, searchPaths);
  const whisper = executable("whisper-cli", env.PI_DICTATE_WHISPER, searchPaths);
  const model = env.PI_DICTATE_MODEL ?? join(root, "models/ggml-small.en.bin");
  const hasModel = accessibleFile(model, constants.R_OK);
  if (env.PI_DICTATE_MODEL !== undefined && (!isAbsolute(model) || !hasModel)) {
    throw new Error(`Configured model is not a readable file: ${model}. Fix PI_DICTATE_MODEL; setup will not download over a custom path.`);
  }
  const missing: SetupPlan["missing"] = [];
  if (!sox) missing.push("SoX");
  if (!whisper) missing.push("whisper.cpp");
  if (!hasModel) missing.push("small.en model");
  if (missing.length) {
    const brew = executable("brew", undefined, searchPaths);
    if ((!sox || !whisper) && !brew) {
      throw new Error(`Missing ${missing.join(", ")}. Install Homebrew from https://brew.sh, then run /talk again. Homebrew itself is never installed automatically.`);
    }
    throw new SetupRequiredError({ root, missing, downloadModel: !hasModel, brew, sox, whisper });
  }
  return { sox: sox!, whisper: whisper!, model, language: env.PI_DICTATE_LANGUAGE ?? "en", vocabulary };
}
