import { BeatSheet, EvidenceBase, Script, Treatment, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { WRITER } from "../models.ts";
import { stage, type RunContext } from "../pipeline.ts";
import { grounding } from "../gates/grounding.ts";
import { prose } from "../gates/prose.ts";
import { readTime } from "../gates/read_time.ts";
import { NARRATION_WPM } from "../gates/read_time.ts";
import { retryBlock } from "./treatment.ts";

/**
 * script: the human approval point (docs/DECISIONS.md #9).
 *
 * Three gates run here and they check different things: grounding checks
 * truth, prose checks whether anyone would watch, read_time checks length.
 * All three must pass before a human is asked to read it, so review time is
 * spent on judgment rather than on catching arithmetic.
 *
 * Prompt ordering is deliberate: the evidence base goes FIRST and the variable
 * instructions last. The evidence is by far the largest part of the prompt and
 * is byte-identical across retries, so as a stable prefix it hits Fireworks'
 * prompt cache at ~10x lower input cost. Putting the retry feedback at the top
 * would invalidate the prefix on every attempt.
 */

const SYSTEM = `You write narration for long-form historical documentary.

THE ABSOLUTE RULE: every factual statement you write must be supported by an
evidence entry supplied to you, and that entry's id must appear in that
segment's evidence_ids. You have no other knowledge. If a detail you want is
not in the evidence, you cannot use it — write around the gap or leave it out.
Inventing a date, a number, a name, or a quotation fails the run.

Style:
- Write for the ear. Short declaratives carry weight; vary sentence length.
- Concrete over abstract. A named person doing a specific thing beats a
  generalisation about an era.
- Trust the material. Do not tell the viewer something is shocking; state the
  fact plainly and let it land.
- No direct address, no "we", no rhetorical questions as transitions.
- Never signpost structure ("in this video", "first, let's look at").
- Do not summarise at the end. Finish on the strongest concrete fact.
- Numbers as spoken: "eight thousand", not "8,000". This is read aloud.

Segmentation: one segment is one narration paragraph, 40-90 words, mapped to
exactly one beat. Several segments per beat is normal and expected.

Contested evidence: when an entry is marked contested, say so in the narration
("estimates range from...", "the figure is disputed"). Never pick a side.`;

export async function runScript(
  ctx: RunContext,
  input: { treatment: Treatment; evidence: EvidenceBase; beatSheet: BeatSheet }
) {
  const { treatment, evidence, beatSheet } = input;
  const targetWords = Math.round((treatment.target_runtime_s / 60) * NARRATION_WPM);

  // Stable prefix: identical bytes on every attempt, so it caches.
  const evidenceBlock = [
    "EVIDENCE BASE — the only facts you may use:",
    ...evidence.entries.map(
      (e) => `${e.id}. [${e.confidence}] ${e.claim}${e.quote ? ` — "${e.quote}"` : ""}`
    ),
  ].join("\n");

  return stage({
    ctx,
    name: "script",
    schema: Script,
    gates: [
      (a) => grounding(a, ctx, evidence),
      (a) => readTime(a, treatment),
      (a) => prose(a, ctx),
    ],
    produce: (failures: Failure[]) =>
      complete({
        model: WRITER,
        name: "Script",
        schema: Script,
        runId: ctx.runId,
        stage: "script",
        costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
        temperature: 0.75,
        system: SYSTEM,
        user: [
          evidenceBlock,
          "",
          "BEAT SHEET — follow this order:",
          `Hook: ${beatSheet.hook}`,
          ...beatSheet.beats.map(
            (b) =>
              `${b.id} — ${b.chapter_title}: ${b.summary}` +
              (b.open_loop ? `\n    plants: ${b.open_loop}` : "") +
              (b.resolves ? `\n    resolves: ${b.resolves}` : "") +
              `\n    evidence: ${b.evidence_ids.join(", ")}`
          ),
          "",
          `Angle: ${treatment.angle}`,
          `Central question to answer: ${treatment.central_question}`,
          `Total length: about ${targetWords} words (${treatment.target_runtime_s}s at ${NARRATION_WPM} wpm).`,
          "Open with the hook as your first segment.",
          retryBlock(failures),
        ]
          .filter(Boolean)
          .join("\n"),
      }),
  });
}
