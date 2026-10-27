import { execa } from "execa";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * BreezeBlue TTS (Breeze TTS 2). Plain fetch, no SDK — their published client
 * is Python, which CLAUDE.md rules out.
 *
 * Contract verified against docs.breezeblue.ai on 2026-09-14:
 *   POST https://api.breeze.blue/v1/text-to-speech/{voice_id}?output_format=wav
 *   header: xi-api-key: brz_...
 *   body:   { text, model_id, language_code?, instructions?, voice_settings? }
 *   returns raw binary audio
 *
 * LICENSING — read before shipping a published video. Breeze TTS 2 weights are
 * under the BreezeBlue Research and Non-Commercial License. Commercial rights
 * to generated audio come only from their hosted platform on an active PAID
 * subscription. A dev/demo key is not that. See docs/DECISIONS.md #6, which
 * flagged exactly this risk for open-weight voice models.
 *
 * Measured behaviour that the pipeline depends on:
 *   - `wav` returns 24 kHz mono PCM s16le, the model's native rate. `pcm_*` is
 *     headerless and unusable; mp3 is a lossy round-trip before alignment.
 *   - Synthesis runs at roughly 3x realtime, so a 10-minute narration is ~30
 *     minutes sequential. Hence per-segment caching and bounded concurrency.
 *   - Output is NON-DETERMINISTIC: the same text resynthesised gives a
 *     different duration. Never assume a duration; always measure the file we
 *     keep, and never re-synthesise a segment whose audio already exists or
 *     every downstream timing shifts.
 */

const BASE_URL = "https://api.breeze.blue/v1";

export const MODEL_ID = "breeze-tts-2";

/** Native output. 24 kHz mono is what the model actually produces. */
export const OUTPUT_FORMAT = "wav";
export const SAMPLE_RATE = 24_000;

/**
 * Default voice: Aquilo, male/middle-aged/american, calm + authoritative +
 * measured, in Breeze's `narration` category. Most of the library skews
 * gaming, and many "narration" voices are written for fantasy ("deity-like
 * presence"); this is the most neutral documentary fit of the 50 available.
 */
export const DEFAULT_VOICE_ID = "voc_an4aj9p66p9t";

/**
 * Delivery direction. Breeze accepts free-text `instructions`, which is a
 * better lever on register than the `speed` number, whose effect measured as
 * unreliable (0.9 produced no change from 1.0).
 */
export const DEFAULT_INSTRUCTIONS =
  "Read as measured documentary narration: unhurried, even, and factual. " +
  "Let full stops land as real pauses. Do not dramatise, do not rise at the " +
  "end of sentences, and do not perform emotion — the facts carry the weight.";

function apiKey(): string {
  const key = process.env.BREEZE_API_KEY;
  if (!key) {
    throw new Error(
      "BREEZE_API_KEY is not set.\n" +
        "Add it to .env:  BREEZE_API_KEY=brz_..."
    );
  }
  return key;
}

export type SynthOpts = {
  text: string;
  outPath: string;
  voiceId?: string;
  instructions?: string;
  /** 0.5-2.0. Measured as a weak lever; prefer `instructions`. */
  speed?: number;
  /** 1.0-10.0. Higher tracks the instructions more literally. */
  guidanceScale?: number;
  languageCode?: string;
  maxRetries?: number;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Synthesise one span of text to a wav file. Returns its measured duration. */
export async function synthesize(opts: SynthOpts): Promise<{ durationS: number; bytes: number; cached: boolean }> {
  // Never re-synthesise existing audio: output is non-deterministic, so a
  // needless regeneration silently shifts every downstream timing.
  if (existsSync(opts.outPath) && statSync(opts.outPath).size > 1024) {
    return { durationS: await probeDuration(opts.outPath), bytes: statSync(opts.outPath).size, cached: true };
  }

  mkdirSync(dirname(opts.outPath), { recursive: true });

  const url = `${BASE_URL}/text-to-speech/${opts.voiceId ?? DEFAULT_VOICE_ID}?output_format=${OUTPUT_FORMAT}`;
  const body: Record<string, unknown> = {
    text: opts.text,
    model_id: MODEL_ID,
    instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
    voice_settings: {
      speed: opts.speed ?? 1.0,
      guidance_scale: opts.guidanceScale ?? 2.0,
    },
  };
  if (opts.languageCode) body.language_code = opts.languageCode;

  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // 3x realtime means a 90-word segment can take 90s. Be patient.
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = Object.assign(
          new Error(`BreezeBlue ${res.status} ${res.statusText}: ${detail.slice(0, 400)}`),
          { status: res.status }
        );
        throw err;
      }

      const buf = Buffer.from(await res.arrayBuffer());

      // A 200 carrying JSON or a stub is an API contract change, not audio.
      if (buf.length < 1024 || buf.subarray(0, 4).toString("ascii") !== "RIFF") {
        throw new Error(
          `BreezeBlue returned ${buf.length} bytes that are not RIFF/WAVE.\n` +
            `--- first 200 bytes ---\n${buf.subarray(0, 200).toString("utf8")}`
        );
      }

      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.outPath, buf);

      return { durationS: await probeDuration(opts.outPath), bytes: buf.length, cached: false };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (!(status !== undefined && RETRYABLE.has(status)) || attempt === maxRetries) break;
      const backoff = 2000 * 2 ** (attempt - 1);
      console.warn(`    tts: ${status}, retrying in ${backoff}ms (${attempt}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr;
}

/** Duration measured from the file, never estimated. */
export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    path,
  ]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe gave no usable duration for ${path}`);
  return d;
}
