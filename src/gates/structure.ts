import { z } from "zod";
import { BeatSheet, EvidenceBase, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { CHEAP } from "../models.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";

/**
 * structure gate: do the loops close, and is the reveal held back?
 *
 * Loop bookkeeping and evidence-id validity are checked in code because they
 * are graph properties, not judgments. Only the hook's quality and the
 * placement of the conclusion need a model.
 */

const Judgment = z.object({
  hook_poses_question: z
    .boolean()
    .describe("Does the hook pose a question rather than summarising or answering?"),
  conclusion_front_loaded: z
    .boolean()
    .describe("Is the main reveal given away in the hook or the first third?"),
  notes: z.string().describe("One sentence per problem found. Empty string if none."),
});

export async function structure(bs: BeatSheet, ctx: RunContext, evidence: EvidenceBase) {
  const failures: Failure[] = [];
  const beatIds = new Set(bs.beats.map((b) => b.id));
  const evidenceIds = new Set(evidence.entries.map((e) => e.id));

  const dupes = bs.beats.map((b) => b.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) {
    failures.push({
      code: "duplicate_beat_ids",
      message: "Beat ids must be unique.",
      offending: [...new Set(dupes)].join(", "),
    });
  }

  // A beat citing an evidence id that does not exist is the beat-sheet-level
  // version of a fabricated source, so it is a hard failure, not a warning.
  for (const b of bs.beats) {
    const unknown = b.evidence_ids.filter((id) => !evidenceIds.has(id));
    if (unknown.length) {
      failures.push({
        code: "unknown_evidence_id",
        message: `Beat ${b.id} cites evidence ids that do not exist: ${unknown.join(", ")}.`,
        offending: b.chapter_title,
      });
    }
    if (b.evidence_ids.length === 0) {
      failures.push({
        code: "unsupported_beat",
        message: `Beat ${b.id} ("${b.chapter_title}") cites no evidence at all.`,
        offending: b.summary,
      });
    }
  }

  // Loop bookkeeping: every planted loop must be closed, every close must
  // point at a real beat that actually planted one.
  const planters = bs.beats.filter((b) => b.open_loop);
  const closedIds = new Set(bs.beats.map((b) => b.resolves).filter(Boolean) as string[]);

  for (const p of planters) {
    if (!closedIds.has(p.id)) {
      failures.push({
        code: "unresolved_loop",
        message: `Beat ${p.id} plants a question that no later beat resolves.`,
        offending: p.open_loop,
      });
    }
  }

  for (const b of bs.beats) {
    if (!b.resolves) continue;
    if (!beatIds.has(b.resolves)) {
      failures.push({
        code: "dangling_resolve",
        message: `Beat ${b.id} claims to resolve "${b.resolves}", which is not a beat.`,
        offending: b.chapter_title,
      });
      continue;
    }
    const target = bs.beats.find((x) => x.id === b.resolves)!;
    if (!target.open_loop) {
      failures.push({
        code: "resolves_nothing",
        message: `Beat ${b.id} resolves beat ${target.id}, but ${target.id} plants no open loop.`,
        offending: b.chapter_title,
      });
    }
    if (bs.beats.indexOf(target) > bs.beats.indexOf(b)) {
      failures.push({
        code: "backwards_loop",
        message: `Beat ${b.id} resolves ${target.id}, which comes later. A loop must be planted before it closes.`,
        offending: b.chapter_title,
      });
    }
  }

  if (planters.length === 0) {
    failures.push({
      code: "no_loops",
      message: "No beat plants an open question. Nothing pulls the viewer forward.",
      offending: null,
    });
  }

  const j = await complete({
    model: CHEAP,
    name: "StructureJudgment",
    schema: Judgment,
    runId: ctx.runId,
    stage: "beat_sheet",
    gate: "structure",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0,
    system:
      "You assess documentary structure. Be strict about the hook: summarising " +
      "the video is the most common failure and is not a question.",
    user:
      `Hook: ${bs.hook}\n\nBeats in order:\n` +
      bs.beats.map((b, i) => `${i + 1}. ${b.chapter_title} — ${b.summary}`).join("\n"),
  });

  if (!j.hook_poses_question) {
    failures.push({
      code: "weak_hook",
      message: "The hook does not pose a question; it summarises or answers.",
      offending: bs.hook,
    });
  }
  if (j.conclusion_front_loaded) {
    failures.push({
      code: "front_loaded",
      message: "The reveal is given away too early; it belongs in the last third.",
      offending: j.notes,
    });
  }

  return failures.length ? fail("structure", failures) : pass("structure");
}
