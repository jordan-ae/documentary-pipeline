import { z } from "zod";
import { EvidenceBase, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { CHEAP } from "../models.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";

/**
 * sufficiency gate: is this evidence base enough to write from?
 *
 * Split deliberately between code and model. Entry counts, source diversity
 * and claim atomicity are objective, so they are computed, not judged — a
 * model asked "is this atomic?" is slower, costlier, and less consistent than
 * a regex that counts the years in a sentence. Only the one genuinely
 * subjective question ("does this cover the central question?") goes to a
 * model.
 *
 * docs/ARCHITECTURE.md lists this gate as cheap-model; the coverage half is.
 */

export type SufficiencyConfig = {
  minEntries: number;
  minSources: number;
  /**
   * Enforce ">=2 independent sources on load-bearing claims".
   *
   * OFF for now, and this is a real limitation rather than an oversight: the
   * evidence base is currently built from one corpus (Wikipedia), so two
   * articles agreeing are not two independent sources. Turning this on
   * requires actually fetching the third-party URLs harvested into
   * candidate_sources.json. Left visible rather than quietly dropped.
   */
  requireCorroboration: boolean;
};

const DEFAULTS: SufficiencyConfig = {
  minEntries: 20,
  minSources: 2,
  requireCorroboration: false,
};

const Coverage = z.object({
  answers_central_question: z
    .boolean()
    .describe("Could someone write a complete answer to the central question from these claims alone?"),
  missing: z
    .string()
    .describe("What a writer would still need. Empty string if nothing material is missing."),
});

/** A claim is load-bearing if it asserts a specific quantity, date, or figure. */
function isLoadBearing(claim: string): boolean {
  return /\b\d{3,}\b|\b1[6-9]\d{2}\b|\b20\d{2}\b|\$[\d,]+|\b\d+(\.\d+)?\s?(percent|%|mph|km\/h|feet|ft|metres|meters)\b/i.test(
    claim
  );
}

/**
 * Two independent dates or several unrelated figures mean it is two claims.
 *
 * Counting raw numbers does not work on encyclopedia prose, which is full of
 * single facts that look compound:
 *
 *   "1,160 mi (1,865 km) east"          one distance, two units
 *   "winds of 140 mph (225 km/h)"       one speed, two units
 *   "chief meteorologist from 1889 to 1901"   one tenure, two years
 *   "extended between 1904 and 1963"    one programme, two years
 *
 * All four are atomic. An earlier version of this check flagged every one of
 * them, which made the gate unsatisfiable: the model was producing correct
 * atomic claims, so no retry could ever pass, and each run burned three
 * attempts before aborting. Normalise the prose first, then count.
 */
export function notAtomic(claim: string): boolean {
  const normalized = claim
    // Parenthetical unit conversions and asides are never a second fact.
    .replace(/\([^)]*\)/g, " ")
    // Ranges are one span: "from X to Y", "between X and Y", "X-Y", "X to Y".
    .replace(/\b(?:from|between|either)\s+\d[\d,]*\s+(?:to|and|or|through|until)\s+\d[\d,]*/gi, " RANGE ")
    .replace(/\b\d[\d,]*\s*(?:-|–|—|to|or)\s*\d[\d,]*\b/g, " RANGE ")
    // A year can be part of a NAME rather than a date: "the 1900 Galveston
    // hurricane", "a 2008 reanalysis". Those are qualifiers, not second facts,
    // and a claim comparing two named storms is still one claim.
    .replace(/\b(?:1[6-9]\d{2}|20\d{2})\s+(?=[A-Z])/g, " NAMED ")
    .replace(
      /\b(?:1[6-9]\d{2}|20\d{2})\s+(?=(?:reanalysis|analysis|study|studies|report|review|survey|paper|assessment|estimate)\b)/gi,
      " NAMED "
    );

  const years = new Set(normalized.match(/\b1[6-9]\d{2}\b|\b20\d{2}\b/g) ?? []);
  const figures = new Set(
    (normalized.match(/\b\d{3,}(?:,\d{3})*\b/g) ?? []).filter((n) => !years.has(n))
  );

  // After normalisation an atomic claim carries at most one standalone figure;
  // a date plus one measurement is normal prose, two unrelated figures are not.
  return years.size > 1 || figures.size > 1;
}

export async function sufficiency(
  base: EvidenceBase,
  ctx: RunContext,
  centralQuestion: string,
  config: Partial<SufficiencyConfig> = {}
) {
  const cfg = { ...DEFAULTS, ...config };
  const failures: Failure[] = [];
  const entries = base.entries;

  if (entries.length < cfg.minEntries) {
    failures.push({
      code: "too_few_entries",
      message: `Only ${entries.length} evidence entries; need at least ${cfg.minEntries} to write from.`,
      offending: null,
    });
  }

  const sources = new Set(entries.map((e) => e.source_url));
  if (sources.size < cfg.minSources) {
    failures.push({
      code: "too_few_sources",
      message: `Claims come from only ${sources.size} source(s); need at least ${cfg.minSources}.`,
      offending: [...sources].join(", ") || null,
    });
  }

  const duplicateIds = entries.map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicateIds.length) {
    failures.push({
      code: "duplicate_ids",
      message: "Evidence ids must be unique; the script references them by id.",
      offending: [...new Set(duplicateIds)].join(", "),
    });
  }

  for (const e of entries.filter((e) => notAtomic(e.claim)).slice(0, 8)) {
    failures.push({
      code: "not_atomic",
      message: `Entry ${e.id} contains more than one fact and must be split.`,
      offending: e.claim,
    });
  }

  // A quote field that is not actually in its source is a fabricated quotation,
  // which is the single worst failure mode this project can have.
  const loadBearing = entries.filter((e) => isLoadBearing(e.claim));
  const corroborated = loadBearing.filter(
    (e) =>
      entries.some(
        (other) => other.id !== e.id && other.source_url !== e.source_url && overlaps(other.claim, e.claim)
      )
  );
  const pct = loadBearing.length ? Math.round((corroborated.length / loadBearing.length) * 100) : 0;
  console.log(
    `      corroboration: ${corroborated.length}/${loadBearing.length} load-bearing claims (${pct}%) ` +
      `appear in >1 source${cfg.requireCorroboration ? "" : " [not enforced: single-corpus retrieval]"}`
  );

  if (cfg.requireCorroboration) {
    for (const e of loadBearing.filter((e) => !corroborated.includes(e)).slice(0, 8)) {
      failures.push({
        code: "uncorroborated",
        message: `Load-bearing claim ${e.id} appears in only one source.`,
        offending: e.claim,
      });
    }
  }

  const coverage = await complete({
    model: CHEAP,
    name: "Coverage",
    schema: Coverage,
    runId: ctx.runId,
    stage: "evidence_base",
    gate: "sufficiency",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0,
    system:
      "You judge whether an evidence base is sufficient to write a documentary script. " +
      "Judge only coverage of the stated question. Do not comment on style.",
    user:
      `Central question: ${centralQuestion}\n\nClaims:\n` +
      entries.map((e) => `${e.id}. ${e.claim}`).join("\n"),
  });

  if (!coverage.answers_central_question) {
    failures.push({
      code: "incomplete_coverage",
      message: "The evidence base cannot answer the central question.",
      offending: coverage.missing,
    });
  }

  return failures.length ? fail("sufficiency", failures) : pass("sufficiency");
}

/** Crude shared-content test: do two claims discuss the same specific figures? */
function overlaps(a: string, b: string): boolean {
  const key = (s: string) => new Set(s.match(/\b\d{3,}(?:,\d{3})*\b|\b1[6-9]\d{2}\b|\b20\d{2}\b/g) ?? []);
  const ka = key(a);
  const kb = key(b);
  if (ka.size === 0 || kb.size === 0) return false;
  for (const v of ka) if (kb.has(v)) return true;
  return false;
}
