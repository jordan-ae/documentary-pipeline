import { Script, Treatment, type Failure } from "../artifacts.ts";
import { fail, pass } from "../pipeline.ts";

/**
 * read_time gate. No model, per docs/ARCHITECTURE.md — this is arithmetic.
 *
 * This is the estimate used BEFORE synthesis. Once narration exists, real word
 * timings replace it, and scene boundaries come from those timings and never
 * from this number (see the ShotList note in ARCHITECTURE.md).
 *
 * CALIBRATED, not assumed. 162 wpm is measured from Breeze TTS 2 (voice
 * Aquilo, speed 1.0) including the inter-segment gaps the narration stage
 * inserts: 82 words rendered as 30.38s of audio on 2026-09-14. The initial
 * guess here was 145, which would have sized every script ~12% short of its
 * target runtime.
 *
 * Re-derive this from `measured_wpm` in narration.json as real runs land —
 * the rate varies with sentence length and punctuation density, and one
 * 82-word sample is thin evidence. It is recorded on every run for exactly
 * that reason.
 */

export const NARRATION_WPM = 162;

/** Generous enough not to thrash the writer, tight enough to matter. */
const TOLERANCE = 0.12;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function readTime(script: Script, treatment: Treatment) {
  const words = script.segments.reduce((a, s) => a + countWords(s.text), 0);
  const estimatedS = (words / NARRATION_WPM) * 60;
  const target = treatment.target_runtime_s;
  const low = target * (1 - TOLERANCE);
  const high = target * (1 + TOLERANCE);

  console.log(
    `      read_time: ${words} words ≈ ${Math.round(estimatedS)}s at ${NARRATION_WPM} wpm ` +
      `(target ${target}s, window ${Math.round(low)}–${Math.round(high)}s)`
  );

  const failures: Failure[] = [];

  if (estimatedS < low) {
    const needed = Math.ceil(((low - estimatedS) / 60) * NARRATION_WPM);
    failures.push({
      code: "too_short",
      message: `Script runs ~${Math.round(estimatedS)}s, under the ${Math.round(low)}s floor. Add about ${needed} more words of substance — more evidence, not more adjectives.`,
      offending: null,
    });
  }

  if (estimatedS > high) {
    const excess = Math.ceil(((estimatedS - high) / 60) * NARRATION_WPM);
    failures.push({
      code: "too_long",
      message: `Script runs ~${Math.round(estimatedS)}s, over the ${Math.round(high)}s ceiling. Cut about ${excess} words.`,
      offending: null,
    });
  }

  return failures.length ? fail("read_time", failures) : pass("read_time");
}
