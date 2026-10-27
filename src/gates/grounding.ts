import { z } from "zod";
import { EvidenceBase, Script, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { CHEAP } from "../models.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";
import { mapLimit } from "../concurrency.ts";

/**
 * grounding gate. The one non-negotiable, per CLAUDE.md.
 *
 * Two passes, and the separation is the entire point:
 *
 *   1. EXTRACT claims from the segment text with NO evidence in context.
 *   2. VERIFY each claim against that segment's cited evidence.
 *
 * Doing both in one call looks like it saves half the calls and quietly breaks
 * the gate. A model that can see the evidence while deciding what counts as a
 * claim will extract the supported sentences and skip the invented ones — the
 * fabrication never enters the list, so it can never fail. Extraction has to
 * be blind for the check to mean anything.
 */

const Claims = z.object({
  claims: z
    .array(z.string())
    .describe("Every factual assertion in the text, each stated atomically."),
});

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      claim: z.string(),
      supported: z.boolean().describe("Is this claim supported by the supplied evidence?"),
      evidence_id: z
        .string()
        .nullable()
        .describe("The evidence id that supports it, or null if unsupported."),
      why: z.string().describe("If unsupported, what the evidence does not establish."),
    })
  ),
});

const EXTRACT_SYSTEM = `You list the factual assertions in a passage of narration.

A factual assertion is anything a fact-checker could mark true or false.

ALWAYS a claim:
- dates, years, durations
- numbers, counts, death tolls, measurements, money
- named people, named places, named institutions and what they did
- quotations and anything attributed to a person
- causal statements ("because", "as a result", "which led to")

NOT a claim:
- rhetorical or transitional phrasing ("but that is not what happened")
- direct address to the viewer
- scene-setting with no verifiable content ("the morning was ordinary")

If you are unsure, treat it AS a claim. List each atomically: one fact per
entry, split compound sentences. Do not interpret, do not judge truth, and do
not omit an assertion because it seems obvious.`;

const VERIFY_SYSTEM = `You check whether each claim is supported by the supplied evidence.

"Supported" means the evidence states the claim, or states something the claim
follows from directly. It is NOT support if:
- the evidence is about the same topic but does not establish this fact
- the claim is more specific than the evidence (a precise number where the
  evidence gives a range, a date where the evidence gives a year)
- the claim adds attribution, causation, or certainty the evidence lacks

Be literal and unsympathetic. A claim that is probably true in the real world
but absent from the evidence is UNSUPPORTED. That is the entire purpose of
this check.`;

export async function grounding(script: Script, ctx: RunContext, evidence: EvidenceBase) {
  const byId = new Map(evidence.entries.map((e) => [e.id, e]));
  const failures: Failure[] = [];

  // Bounded rather than Promise.all over every segment: a 20-segment script
  // would otherwise open 20 simultaneous requests and trip rate limits.
  const perSegment = await mapLimit(script.segments, 5, async (seg) => {
      // Pass 1: blind extraction. Evidence is deliberately absent here.
      const { claims } = await complete({
        model: CHEAP,
        name: "Claims",
        schema: Claims,
        runId: ctx.runId,
        stage: "script",
        gate: "grounding",
        costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
        temperature: 0,
        system: EXTRACT_SYSTEM,
        user: `Narration passage:\n\n${seg.text}`,
      });

      if (claims.length === 0) return { seg, unsupported: [], total: 0 };

      const cited = seg.evidence_ids.map((id) => byId.get(id)).filter(Boolean);

      // A segment making claims while citing nothing cannot be checked; it is
      // by definition ungrounded, so short-circuit without spending a call.
      if (cited.length === 0) {
        return {
          seg,
          total: claims.length,
          unsupported: claims.map((claim) => ({ claim, why: "The segment cites no evidence." })),
        };
      }

      // Pass 2: verification, with evidence present.
      const { verdicts } = await complete({
        model: CHEAP,
        name: "Verdicts",
        schema: Verdicts,
        runId: ctx.runId,
        stage: "script",
        gate: "grounding",
        costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
        temperature: 0,
        system: VERIFY_SYSTEM,
        user: [
          "EVIDENCE:",
          ...cited.map((e) => `${e!.id}. [${e!.confidence}] ${e!.claim}${e!.quote ? ` — "${e!.quote}"` : ""}`),
          "",
          "CLAIMS TO CHECK:",
          ...claims.map((c, i) => `${i + 1}. ${c}`),
        ].join("\n"),
      });

      return {
        seg,
        total: claims.length,
        unsupported: verdicts
          .filter((v) => !v.supported)
          .map((v) => ({ claim: v.claim, why: v.why })),
      };
    }
  );

  const totalClaims = perSegment.reduce((a, s) => a + s.total, 0);
  const totalUnsupported = perSegment.reduce((a, s) => a + s.unsupported.length, 0);

  for (const { seg, unsupported } of perSegment) {
    for (const u of unsupported) {
      failures.push({
        code: "unsupported_claim",
        message: `Segment ${seg.id}: claim is not supported by its cited evidence (${seg.evidence_ids.join(", ") || "none cited"}). ${u.why}`,
        offending: u.claim,
      });
    }
  }

  // Unknown ids are checked here too, because a segment citing e99 would
  // otherwise appear to have support.
  for (const seg of script.segments) {
    const unknown = seg.evidence_ids.filter((id) => !byId.has(id));
    if (unknown.length) {
      failures.push({
        code: "unknown_evidence_id",
        message: `Segment ${seg.id} cites evidence ids that do not exist: ${unknown.join(", ")}.`,
        offending: seg.text.slice(0, 160),
      });
    }
  }

  console.log(
    `      grounding: ${totalClaims - totalUnsupported}/${totalClaims} claims supported ` +
      `across ${script.segments.length} segments`
  );

  return failures.length ? fail("grounding", failures) : pass("grounding");
}
