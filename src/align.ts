import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { Word } from "./artifacts.ts";
import type { RunContext } from "./pipeline.ts";

/**
 * Forced alignment via nodejs-whisper (whisper.cpp bindings), per CLAUDE.md.
 *
 * This is what locks scene boundaries to narration: ARCHITECTURE.md is
 * explicit that ShotList timings come from these word timings and are never
 * computed from word counts or estimated WPM.
 *
 * whisper.cpp needs a native build (cmake + a C++ toolchain) and a one-time
 * model download, so `assertWhisperAvailable` is called BEFORE any TTS spend
 * rather than after.
 */

/** whisper.cpp requires 16 kHz mono; Breeze produces 24 kHz. */
const WHISPER_RATE = 16_000;

/** Non-literal so tsc does not resolve this optional native dep at build time. */
const WHISPER_PKG = "nodejs-whisper";

/** base.en is accurate enough for diffing our own TTS and fast on CPU. */
export const WHISPER_MODEL = "base.en";

/**
 * Expected size of each ggml model, in bytes, used only as a completeness
 * floor. A truncated model is the likely failure on a slow link, and
 * whisper.cpp reports it as an opaque load error rather than "your file is
 * half-downloaded".
 */
const MODEL_MIN_BYTES: Record<string, number> = {
  "tiny.en": 70_000_000,
  "base.en": 130_000_000,
  "small.en": 450_000_000,
};

/**
 * Verify the model file is present AND complete before whisper.cpp touches it.
 *
 * Checks the ggml magic bytes and a size floor. A partial download otherwise
 * surfaces as a cryptic load failure halfway through a run that has already
 * paid for TTS.
 */
export function assertModelReady(modelName: string = WHISPER_MODEL): void {
  const path = join(
    "node_modules",
    "nodejs-whisper",
    "cpp",
    "whisper.cpp",
    "models",
    `ggml-${modelName}.bin`
  );

  if (!existsSync(path)) {
    throw new Error(
      `Whisper model ggml-${modelName}.bin is not downloaded yet.\n` +
        `  expected at: ${path}\n` +
        `  fix: npx nodejs-whisper download    (or curl it directly, resumable)`
    );
  }

  const size = statSync(path).size;
  const floor = MODEL_MIN_BYTES[modelName] ?? 1_000_000;
  if (size < floor) {
    throw new Error(
      `Whisper model ggml-${modelName}.bin is incomplete: ${(size / 1048576).toFixed(1)} MB, ` +
        `expected at least ${(floor / 1048576).toFixed(0)} MB.\n` +
        `  A partial download would fail inside whisper.cpp with an opaque error.\n` +
        `  Resume it: curl -L -C - -o ${path} \\\n` +
        `    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`
    );
  }

  // ggml files begin with the magic bytes "ggml".
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    const magic = head.toString("ascii");
    if (magic !== "ggml") {
      throw new Error(
        `Whisper model ggml-${modelName}.bin is not a ggml file (header "${magic}").\n` +
          `  This is usually an HTML error page saved under the model's name.\n` +
          `  Delete it and download again: ${path}`
      );
    }
  } finally {
    closeSync(fd);
  }
}

export async function assertWhisperAvailable(): Promise<void> {
  const problems: string[] = [];

  try {
    await execa("cmake", ["--version"]);
  } catch {
    problems.push(
      "cmake is not installed — whisper.cpp cannot build.\n" +
        "    fix:  brew install cmake"
    );
  }

  try {
    await import(WHISPER_PKG);
  } catch {
    problems.push(
      "nodejs-whisper is not installed.\n" +
        "    fix:  npm i nodejs-whisper  (then it downloads the model on first run)"
    );
  }

  if (problems.length) {
    throw new Error(
      "Forced alignment is unavailable, so narration cannot produce word timings.\n\n" +
        problems.map((p) => `  - ${p}`).join("\n\n") +
        "\n\nTo exercise the TTS path only, rerun with --skip-align. That emits an\n" +
        "empty words[] and is NOT finished narration — shot_list cannot use it."
    );
  }
}

/** Resample to what whisper.cpp accepts. Returns the 16 kHz path. */
export async function toWhisperWav(audioPath: string, ctx: RunContext): Promise<string> {
  const out = join(ctx.dir, "audio", "_whisper16k.wav");
  await execa("ffmpeg", [
    "-y",
    "-i", audioPath,
    "-ar", String(WHISPER_RATE),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    out,
  ]);
  return out;
}

/** Word-level timings for the whole narration. */
export async function align(audioPath: string, ctx: RunContext): Promise<Word[]> {
  await assertWhisperAvailable();
  assertModelReady();
  const wavPath = await toWhisperWav(audioPath, ctx);

  const { nodewhisper } = (await import(WHISPER_PKG)) as any;

  const raw = await nodewhisper(wavPath, {
    modelName: WHISPER_MODEL,
    autoDownloadModelName: WHISPER_MODEL,
    removeWavFileAfterTranscription: false,
    withCuda: false,
    whisperOptions: {
      outputFormat: "json",
      wordTimestamps: true,
      splitOnWord: true,
    },
  });

  const words = parseWhisperWords(raw);
  if (words.length === 0) {
    throw new Error(
      `Alignment returned no words for ${audioPath}.\n--- raw ---\n${String(raw).slice(0, 600)}`
    );
  }

  console.log(`    aligned: ${words.length} words, last ends at ${words[words.length - 1]!.end_s.toFixed(2)}s`);
  return words;
}

/**
 * nodejs-whisper's return shape varies by version (parsed object, JSON string,
 * or a path to the json). Handle all three rather than guessing one.
 */
export function parseWhisperWords(raw: unknown): Word[] {
  let data: any = raw;

  if (typeof data === "string") {
    const text = data.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      data = JSON.parse(text);
    } else if (existsSync(text)) {
      const { readFileSync } = require("node:fs");
      data = JSON.parse(readFileSync(text, "utf8"));
    } else {
      return [];
    }
  }

  const out: Word[] = [];
  const push = (text: string, start: number, end: number) => {
    const t = String(text).trim();
    if (t) out.push({ text: t, start_s: start, end_s: end });
  };

  const segments = data?.transcription ?? data?.segments ?? (Array.isArray(data) ? data : []);
  for (const seg of segments ?? []) {
    const words = seg?.words ?? seg?.tokens;
    if (Array.isArray(words) && words.length) {
      for (const w of words) {
        const t = timesOf(w);
        if (t) push(w.word ?? w.text ?? "", t.start, t.end);
      }
    } else if (seg?.text) {
      const t = timesOf(seg);
      if (t) push(seg.text, t.start, t.end);
    }
  }

  return out;
}

/**
 * Resolve a node's start/end in seconds.
 *
 * The unit is decided by WHICH field is present, never by magnitude:
 * whisper.cpp's `offsets` are always milliseconds and `start`/`end` are always
 * seconds. Guessing from size silently misplaces timings — and these timings
 * are what scene boundaries are locked to.
 */
function timesOf(node: any): { start: number; end: number } | null {
  if (node?.offsets && (node.offsets.from !== undefined || node.offsets.to !== undefined)) {
    return {
      start: fromMs(node.offsets.from),
      end: fromMs(node.offsets.to),
    };
  }
  if (node?.start !== undefined || node?.end !== undefined) {
    return { start: fromSeconds(node.start), end: fromSeconds(node.end) };
  }
  return null;
}

function fromMs(v: unknown): number {
  if (typeof v === "number") return v / 1000;
  const parsed = parseTimestamp(v);
  return parsed ?? 0;
}

function fromSeconds(v: unknown): number {
  if (typeof v === "number") return v;
  const parsed = parseTimestamp(v);
  return parsed ?? 0;
}

/** "HH:MM:SS,mmm" or a numeric string. */
function parseTimestamp(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+):(\d+):(\d+)[.,](\d+)$/);
  if (m) return +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
