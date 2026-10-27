import { z } from "zod";
import { Script, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { WRITER } from "../models.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";

/**
 * prose gate. The one gate that runs on the expensive model, per
 * ARCHITECTURE.md — judging whether writing is good is exactly the task the
 * cheap model is worst at, and a flash model will wave through copy that a
 * viewer would click away from in ten seconds.
 *
 * Deliberately checks for the tells rather than asking "is this good?", which
 * produces flattery. Mirrors the anti-goals discipline in docs/DESIGN.md.
 */

const TELLS = [
  '"it wasn\'t just X, it was Y" and its variants',
  '"little did they know", "unbeknownst to them"',
  '"in a world where", "imagine a time when"',
  '"stands as a testament to", "serves as a reminder"',
  '"the rest, as they say, is history"',
  "three-item lists used for rhythm rather than content, repeatedly",
  "rhetorical questions used as transitions between every section",
  "sentences that restate the previous sentence in different words",
  "a closing paragraph that summarises what was just said",
  "empty intensifiers: truly, utterly, absolutely, remarkably",
];

const Review = z.object({
  register_consistent: z
    .boolean()
    .describe("Does it hold one voice, without lurching between dry and melodramatic?"),
  rhythm_varied: z
    .boolean()
    .describe("Do sentence lengths vary, or do they march at a uniform length?"),
  tells: z
    .array(z.object({ quote: z.string(), tell: z.string() }))
    .describe("Verbatim spans matching a listed tell. Empty if none. Do not invent matches."),
  worst_passage: z.string().describe("The weakest verbatim span, or empty string if none."),
  worst_reason: z.string(),
});

export async function prose(script: Script, ctx: RunContext) {
  const text = script.segments.map((s) => s.text).join("\n\n");

  const r = await complete({
    model: WRITER,
    name: "ProseReview",
    schema: Review,
    runId: ctx.runId,
    stage: "script",
    gate: "prose",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0.2,
    system:
      "You are a script editor for long-form documentary narration. You are hard " +
      "to please and you quote specifics. Do not praise. Do not suggest rewrites. " +
      "Only report what is wrong, quoting the text verbatim.\n\n" +
      "Known tells to flag:\n" +
      TELLS.map((t) => `- ${t}`).join("\n"),
    user: `Narration script:\n\n${text}`,
  });

  const failures: Failure[] = [];

  // Cap at five so the retry prompt stays actionable instead of becoming a wall.
  for (const t of r.tells.slice(0, 5)) {
    failures.push({
      code: "llm_tell",
      message: `Stock phrasing (${t.tell}). Rewrite this line.`,
      offending: t.quote,
    });
  }

  if (!r.register_consistent) {
    failures.push({
      code: "register",
      message: "The voice is inconsistent; it shifts register between passages.",
      offending: r.worst_passage || null,
    });
  }

  if (!r.rhythm_varied) {
    failures.push({
      code: "rhythm",
      message: "Sentence lengths are uniform. Vary them; let some sentences be short.",
      offending: r.worst_passage || null,
    });
  }

  return failures.length ? fail("prose", failures) : pass("prose");
}
