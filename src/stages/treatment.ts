import { Treatment, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { WRITER } from "../models.ts";
import { stage, type RunContext } from "../pipeline.ts";
import { viability } from "../gates/viability.ts";

/**
 * treatment: decide what the video actually argues.
 *
 * Uses the writer model despite CLAUDE.md's default-to-cheap rule. The output
 * is ~200 tokens, so the call costs a fraction of a cent, and the angle chosen
 * here determines the ceiling on everything downstream. This is the one place
 * where paying 20x for a tiny output is obviously correct.
 */

const SYSTEM = `You are a documentary producer developing a long-form historical video.

You choose ANGLES, not subjects. An angle names the specific tension that makes
a familiar story worth thirteen minutes: an institution that failed, a decision
that looks insane in hindsight, a person who was right and ignored.

Rules:
- The central question must have a real answer, not a rhetorical one.
- Do not propose an angle that requires facts you are not sure exist.
- Never invent a specific claim here. The angle is a frame; the evidence comes
  later and may not support a frame that is too specific.
- No true-crime register, no "what they don't want you to know", no hype.`;

export async function runTreatment(
  ctx: RunContext,
  input: { topic: string; targetRuntimeS: number; angleHint?: string }
) {
  return stage({
    ctx,
    name: "treatment",
    schema: Treatment,
    gates: [(a) => viability(a, ctx)],
    produce: (failures: Failure[]) =>
      complete({
        model: WRITER,
        name: "Treatment",
        schema: Treatment,
        runId: ctx.runId,
        stage: "treatment",
        costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
        temperature: 0.8,
        system: SYSTEM,
        user: [
          `Topic: ${input.topic}`,
          input.angleHint ? `Angle to develop: ${input.angleHint}` : "",
          `Target runtime: ${input.targetRuntimeS} seconds.`,
          `Set target_runtime_s to exactly ${input.targetRuntimeS}.`,
          retryBlock(failures),
        ]
          .filter(Boolean)
          .join("\n"),
      }),
  });
}

/** Gate failures from the previous attempt, fed back in verbatim. */
export function retryBlock(failures: Failure[]): string {
  if (failures.length === 0) return "";
  return [
    "",
    "A previous attempt was REJECTED. Fix every problem below.",
    ...failures.map((f) => `- ${f.message}${f.offending ? `\n  Offending: ${f.offending}` : ""}`),
  ].join("\n");
}
