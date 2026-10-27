import { writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execa } from "execa";
import { Narration, Script, type NarrationSegment } from "../artifacts.ts";
import { stage, type RunContext } from "../pipeline.ts";
import {
  synthesize,
  probeDuration,
  DEFAULT_VOICE_ID,
  MODEL_ID,
  SAMPLE_RATE,
} from "../clients/breezeblue.ts";
import { mapLimit } from "../concurrency.ts";
import { applyLexicon, loadLexicon, proposeLexicon } from "../lexicon.ts";
import { countWords } from "../gates/read_time.ts";
import { asrDiff } from "../gates/asr_diff.ts";
import { align, assertWhisperAvailable, assertModelReady } from "../align.ts";

/**
 * narration: script text -> spoken audio with word-level timings.
 *
 * Synthesised PER SEGMENT rather than as one long request, for three reasons:
 * a failed segment retries for cents instead of re-rendering ten minutes; the
 * per-segment durations give ShotList its segment->time mapping exactly rather
 * than by estimate; and Breeze output is non-deterministic, so cached segments
 * must survive a rerun or every downstream timing shifts.
 *
 * Synthesis is roughly 3x realtime, so a 10-minute narration is ~30 minutes
 * sequential. Bounded concurrency brings that down without hammering the API.
 */

/** Pause inserted between segments. Paragraph breaks need air in narration. */
const SEGMENT_GAP_S = 0.35;

/** Concurrent TTS requests. Modest on purpose: demo keys are rate-limited. */
const TTS_CONCURRENCY = 4;

export type NarrationOpts = {
  script: Script;
  voiceId?: string;
  /**
   * Skip forced alignment and emit `words: []`.
   *
   * Only for exercising the TTS path before whisper.cpp is buildable. It is an
   * explicit flag rather than a silent fallback because ARCHITECTURE.md locks
   * scene boundaries to word timings, so a narration without them is not
   * finished work and must not look finished.
   */
  skipAlign?: boolean;
};

export async function runNarration(ctx: RunContext, input: NarrationOpts) {
  const { script } = input;
  const voiceId = input.voiceId ?? DEFAULT_VOICE_ID;

  return stage({
    ctx,
    name: "narration",
    schema: Narration,
    gates: input.skipAlign ? [] : [(a) => asrDiff(a, ctx, script)],
    produce: async () => {
      // Fail before spending on synthesis, not after. Both the toolchain and
      // the model file are checked here: discovering a half-downloaded model
      // after paying for ten minutes of TTS is the expensive way to find out.
      if (!input.skipAlign) {
        await assertWhisperAvailable();
        assertModelReady();
      }

      const audioDir = join(ctx.dir, "audio");
      mkdirSync(audioDir, { recursive: true });

      // Pronunciation proposals are written for review, never auto-applied.
      // This is a review aid, not a gate: what actually reaches the voice is
      // the committed fixtures/lexicon.json. So a missing writer key must not
      // block synthesis — but it is reported, not silently skipped.
      if (process.env.FIREWORKS_API_KEY) {
        const proposed = await proposeLexicon(ctx, script);
        if (proposed.length) {
          console.log(
            `    lexicon: ${proposed.length} new proper noun(s) proposed for review ` +
              `-> ${join(ctx.dir, "lexicon_proposal.json")}`
          );
          for (const e of proposed.slice(0, 6)) console.log(`      ${e.term} -> ${e.respelling}`);
        }
      } else {
        console.log(`    lexicon: proposal pass skipped (no FIREWORKS_API_KEY).`);
        console.log(`             committed fixtures/lexicon.json still applies.`);
      }

      const lex = loadLexicon();

      console.log(`    synthesising ${script.segments.length} segments (concurrency ${TTS_CONCURRENCY})`);
      let cachedCount = 0;

      const rendered = await mapLimit(script.segments, TTS_CONCURRENCY, async (seg) => {
        const { text: spoken, applied } = applyLexicon(seg.text, lex);
        const outPath = join(audioDir, `${seg.id}.wav`);
        const { durationS, cached } = await synthesize({ text: spoken, outPath, voiceId });
        if (cached) cachedCount++;
        else
          console.log(
            `      ${seg.id}: ${durationS.toFixed(2)}s` +
              (applied.length ? `  [lexicon: ${applied.map((e) => e.term).join(", ")}]` : "")
          );
        return { seg, outPath, durationS };
      });

      if (cachedCount) console.log(`      (${cachedCount} segment(s) reused from cache)`);

      // Concatenate with real silence between segments, accumulating offsets
      // from measured durations so the mapping is exact.
      const silencePath = join(audioDir, "_gap.wav");
      await makeSilence(silencePath, SEGMENT_GAP_S);

      const parts: string[] = [];
      const segments: NarrationSegment[] = [];
      let cursor = 0;

      rendered.forEach((r, i) => {
        parts.push(r.outPath);
        segments.push({
          segment_id: r.seg.id,
          audio_path: relative(ctx.dir, r.outPath),
          start_s: Number(cursor.toFixed(3)),
          end_s: Number((cursor + r.durationS).toFixed(3)),
        });
        cursor += r.durationS;
        if (i < rendered.length - 1) {
          parts.push(silencePath);
          cursor += SEGMENT_GAP_S;
        }
      });

      const audioPath = join(ctx.dir, "narration.wav");
      await concat(parts, audioPath, audioDir);

      const durationS = await probeDuration(audioPath);
      const words = countWords(script.segments.map((s) => s.text).join(" "));
      const measuredWpm = Math.round(words / (durationS / 60));

      // Concatenation must not drift from the accumulated offsets, or every
      // scene boundary downstream is placed against a fiction.
      const drift = Math.abs(durationS - cursor);
      if (drift > 0.25) {
        throw new Error(
          `Concatenated audio is ${durationS.toFixed(2)}s but segment offsets sum to ` +
            `${cursor.toFixed(2)}s (drift ${drift.toFixed(2)}s). Segment timings would be wrong.`
        );
      }

      console.log(
        `    narration: ${durationS.toFixed(1)}s, ${words} words, measured ${measuredWpm} wpm ` +
          `(drift ${drift.toFixed(3)}s)`
      );

      const wordTimings = input.skipAlign ? [] : await align(audioPath, ctx);
      if (input.skipAlign) {
        console.log(`    WARNING: alignment skipped. words[] is empty, so this narration`);
        console.log(`             cannot drive shot_list. Not finished work.`);
      }

      return {
        audio_path: relative(process.cwd(), audioPath),
        duration_s: Number(durationS.toFixed(3)),
        words: wordTimings,
        segments,
        voice_id: voiceId,
        model_id: MODEL_ID,
        measured_wpm: measuredWpm,
      };
    },
  });
}

/** A silence file matching the TTS output format exactly, so -c copy is valid. */
async function makeSilence(path: string, seconds: number): Promise<void> {
  await execa("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    "-t", String(seconds),
    "-c:a", "pcm_s16le",
    path,
  ]);
}

/**
 * Stream-copy concat. Every part is 24 kHz mono pcm_s16le, so no re-encode is
 * needed and the output duration is the exact sum of its parts.
 */
async function concat(parts: string[], outPath: string, workDir: string): Promise<void> {
  const listPath = join(workDir, "_concat.txt");
  // The concat demuxer resolves `file` entries relative to the LIST file's own
  // directory, not the process cwd, so relative paths here silently double up
  // (runs/x/audio/runs/x/audio/s1.wav). Absolute paths are immune to where the
  // list happens to live; -safe 0 is what permits them.
  writeFileSync(
    listPath,
    parts.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join("\n") + "\n"
  );
  await execa("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    outPath,
  ]);
}
