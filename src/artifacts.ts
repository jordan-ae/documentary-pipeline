import { z } from "zod";

/**
 * Artifact schemas. One per pipeline stage, per docs/ARCHITECTURE.md.
 *
 * `.describe()` is not decoration here: these strings are carried into the
 * JSON Schema we hand to Fireworks `response_format`, so they are part of the
 * prompt contract. Changing a description changes model behaviour.
 *
 * Nullable rather than optional throughout. Under constrained decoding a
 * required-but-nullable field makes the model commit to "there is none",
 * whereas an optional field lets it quietly omit the key and lets a missing
 * value read as an intentional one.
 */

export const StageName = z.enum([
  "treatment",
  "evidence_base",
  "beat_sheet",
  "script",
  "narration",
]);
export type StageName = z.infer<typeof StageName>;

/* ---------------------------------------------------------------- treatment */

export const Treatment = z.object({
  topic: z.string(),
  angle: z
    .string()
    .describe(
      "The specific take, not the subject. 'The 1900 Galveston hurricane' is a subject; " +
        "'the forecasting bureau that banned the word hurricane' is an angle."
    ),
  central_question: z
    .string()
    .describe("The single question the finished video answers. Must be answerable, not rhetorical."),
  why_long_form: z
    .string()
    .describe(
      "Why this needs the full runtime rather than five minutes. Name the material that fills it."
    ),
  target_runtime_s: z.int().min(60).max(1800),
});
export type Treatment = z.infer<typeof Treatment>;

/* ------------------------------------------------------------ evidence base */

export const SourceType = z.enum(["academic", "archive", "reference", "news"]);
export type SourceType = z.infer<typeof SourceType>;

export const Confidence = z.enum(["high", "medium", "contested"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
  id: z.string().describe("Short stable id: e1, e2, e3..."),
  claim: z
    .string()
    .describe(
      "One atomic fact. Not a summary and not two facts joined by 'and'. " +
        "If it contains two dates or two numbers it is two entries."
    ),
  source_url: z.string().describe("The exact URL this claim was read from."),
  source_title: z.string(),
  source_type: SourceType,
  confidence: Confidence.describe(
    "'contested' when sources disagree. Never resolve a disagreement yourself: " +
      "record both positions as separate entries, each marked contested."
  ),
  quote: z
    .string()
    .max(240)
    .nullable()
    .describe("Verbatim supporting excerpt from the source, 25 words or fewer. null if none."),
});
export type Evidence = z.infer<typeof Evidence>;

export const EvidenceBase = z.object({
  entries: z.array(Evidence).min(1),
});
export type EvidenceBase = z.infer<typeof EvidenceBase>;

/* --------------------------------------------------------------- beat sheet */

export const Beat = z.object({
  id: z.string().describe("Short stable id: b1, b2, b3..."),
  chapter_title: z
    .string()
    .describe("Used verbatim as an on-screen chapter card and a YouTube timestamp label."),
  summary: z.string(),
  open_loop: z
    .string()
    .nullable()
    .describe("A question deliberately planted here and answered later. null if none."),
  resolves: z
    .string()
    .nullable()
    .describe("The id of an earlier beat whose open_loop this beat closes. null if none."),
  evidence_ids: z.array(z.string()).describe("Evidence entry ids this beat is built from."),
});
export type Beat = z.infer<typeof Beat>;

export const BeatSheet = z.object({
  hook: z.string().describe("The first 15 seconds of narration. Must pose the central question."),
  beats: z.array(Beat).min(2),
});
export type BeatSheet = z.infer<typeof BeatSheet>;

/* ------------------------------------------------------------------- script */

export const Segment = z.object({
  id: z.string().describe("Short stable id: s1, s2, s3..."),
  beat_id: z.string(),
  text: z.string().describe("Narration prose, written to be spoken aloud."),
  evidence_ids: z
    .array(z.string())
    .describe(
      "Every evidence id supporting a factual claim in this segment's text. " +
        "A segment of pure connective tissue may be empty."
    ),
});
export type Segment = z.infer<typeof Segment>;

export const Script = z.object({
  segments: z.array(Segment).min(1),
});
export type Script = z.infer<typeof Script>;

/* ---------------------------------------------------------------- narration */

export const Word = z.object({
  text: z.string(),
  start_s: z.number(),
  end_s: z.number(),
});
export type Word = z.infer<typeof Word>;

/**
 * Where each script segment lands in the concatenated audio.
 *
 * Beyond the three fields ARCHITECTURE.md lists for Narration, and needed:
 * ShotList maps `segment_id` to a time range, and it cannot derive that from a
 * single flat audio file. Offsets are accumulated from measured per-segment
 * durations, so they are exact rather than estimated.
 */
export const NarrationSegment = z.object({
  segment_id: z.string(),
  audio_path: z.string(),
  start_s: z.number(),
  end_s: z.number(),
});
export type NarrationSegment = z.infer<typeof NarrationSegment>;

export const Narration = z.object({
  audio_path: z.string(),
  duration_s: z.number(),
  /** Word-level timings from forced alignment. Empty until alignment runs. */
  words: z.array(Word),
  segments: z.array(NarrationSegment),
  voice_id: z.string(),
  model_id: z.string(),
  /**
   * Words per minute actually produced, measured from the rendered audio.
   * Kept because read_time's WPM constant is an estimate and this is the only
   * real calibration data the pipeline generates.
   */
  measured_wpm: z.number(),
});
export type Narration = z.infer<typeof Narration>;

/* -------------------------------------------------------------------- gates */

export const Failure = z.object({
  /** Stable code so gate failures can be grouped and counted across runs. */
  code: z.string(),
  /** What went wrong, in plain language. Goes into the retry prompt verbatim. */
  message: z.string(),
  /** The offending fragment: a claim, a segment id, an evidence id. */
  offending: z.string().nullable(),
});
export type Failure = z.infer<typeof Failure>;

export type GateResult = {
  gate: string;
  passed: boolean;
  failures: Failure[];
};
