import { BeatSheet, EvidenceBase, Treatment, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { WRITER } from "../models.ts";
import { stage, type RunContext } from "../pipeline.ts";
import { structure } from "../gates/structure.ts";
import { retryBlock } from "./treatment.ts";

/**
 * beat_sheet: the narrative structure, before any prose exists.
 *
 * Separating structure from prose is what stops the script from becoming a
 * chronological recitation. Beats carry open loops explicitly, so the
 * structure gate can verify that every question planted actually gets
 * answered — a check that is impossible once it is all prose.
 */

const SYSTEM = `You structure long-form historical documentaries.

You are given an evidence base. Build a beat sheet from it and nothing else.

Structure requirements:
- The hook is the first 15 seconds of narration. It poses the central question.
  It does not answer it and it does not summarise the video.
- Plant open loops early and resolve them later. Every open_loop must be
  closed by a later beat whose "resolves" field names the beat that planted it.
- Do NOT front-load the conclusion. The reveal belongs in the last third.
- Chapter titles are plain and concrete. They appear on screen and as YouTube
  timestamps. No colons-and-subtitles, no questions, no clickbait.
- Each beat cites the evidence ids it is built from. Use only ids that exist.
- Order beats for causation, not just chronology.`;

export async function runBeatSheet(
  ctx: RunContext,
  input: { treatment: Treatment; evidence: EvidenceBase }
) {
  const { treatment, evidence } = input;

  return stage({
    ctx,
    name: "beat_sheet",
    schema: BeatSheet,
    gates: [(a) => structure(a, ctx, evidence)],
    produce: (failures: Failure[]) =>
      complete({
        model: WRITER,
        name: "BeatSheet",
        schema: BeatSheet,
        runId: ctx.runId,
        stage: "beat_sheet",
        costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
        temperature: 0.7,
        system: SYSTEM,
        user: [
          `Angle: ${treatment.angle}`,
          `Central question: ${treatment.central_question}`,
          `Target runtime: ${treatment.target_runtime_s}s. Plan roughly one beat per 60-90s.`,
          "",
          "EVIDENCE BASE (the only facts available to you):",
          ...evidence.entries.map(
            (e) => `${e.id}. [${e.confidence}] ${e.claim}${e.quote ? ` — "${e.quote}"` : ""}`
          ),
          retryBlock(failures),
        ]
          .filter(Boolean)
          .join("\n"),
      }),
  });
}
