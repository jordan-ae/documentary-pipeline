import { z } from "zod";
import { Treatment, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { CHEAP } from "../models.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";

/**
 * viability gate: can this treatment sustain its runtime?
 *
 * Checks the three things that make long-form history hold: a conflict, a
 * timeline, and a reveal. A topic missing any of them produces a script that
 * reads like an encyclopedia entry stretched to length.
 */

const Verdict = z.object({
  has_conflict: z.boolean().describe("Is there opposition between people, institutions, or ideas?"),
  has_timeline: z.boolean().describe("Do events unfold in a sequence with causation, not just a list?"),
  has_reveal: z
    .boolean()
    .describe("Is there something the audience does not already expect going in?"),
  sustains_runtime: z.boolean().describe("Is there enough substance for the target runtime?"),
  reasoning: z.string().describe("One sentence per failed check, naming what is missing."),
});

export async function viability(t: Treatment, ctx: RunContext) {
  const v = await complete({
    model: CHEAP,
    name: "ViabilityVerdict",
    schema: Verdict,
    runId: ctx.runId,
    stage: "treatment",
    gate: "viability",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0,
    system:
      "You assess whether a documentary treatment can sustain long-form runtime. " +
      "Be strict: most treatments fail on reveal. Judge only what is written, " +
      "not what the topic could theoretically support.",
    user:
      `Angle: ${t.angle}\n` +
      `Central question: ${t.central_question}\n` +
      `Why long form: ${t.why_long_form}\n` +
      `Target runtime: ${t.target_runtime_s}s`,
  });

  const failures: Failure[] = [];
  const check = (ok: boolean, code: string, message: string) => {
    if (!ok) failures.push({ code, message, offending: v.reasoning });
  };

  check(v.has_conflict, "no_conflict", "The angle has no conflict between people, institutions, or ideas.");
  check(v.has_timeline, "no_timeline", "The angle has no causal sequence of events, only a static description.");
  check(v.has_reveal, "no_reveal", "The angle contains nothing the audience would not already expect.");
  check(v.sustains_runtime, "thin", `Not enough substance for ${t.target_runtime_s}s of narration.`);

  return failures.length ? fail("viability", failures) : pass("viability");
}
