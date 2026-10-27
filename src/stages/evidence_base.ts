import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Evidence, EvidenceBase, Treatment, type Failure } from "../artifacts.ts";
import { complete } from "../clients/fireworks.ts";
import { CHEAP } from "../models.ts";
import { stage, type RunContext } from "../pipeline.ts";
import { sufficiency } from "../gates/sufficiency.ts";
import { fetchArticle, searchArticles, type Article } from "../clients/wikimedia.ts";
import { mapLimit } from "../concurrency.ts";

/**
 * evidence_base: retrieve real text, then extract claims from it.
 *
 * The retrieval happens in code (see clients/wikimedia.ts), NOT in the model.
 * That is the whole point: a model asked to research a topic emits confident
 * invented URLs, and the grounding gate downstream would then be validating
 * script claims against fabricated rows. Here the model never supplies a URL —
 * it only reads text we fetched and labels which claims are in it.
 *
 * Extraction runs one call PER ARTICLE. Batching several articles into one
 * context is cheaper but lets the model attribute a claim to the wrong
 * source_url, and correct attribution is the only thing this stage is for.
 *
 * Cost note: this is the highest-token stage in the pipeline (~15k tokens of
 * article text each). It runs on the cheap model deliberately. CLAUDE.md
 * reserves kimi-k3 for "research", but once retrieval is real, this stage is
 * mechanical extraction from supplied text, not research — and it is 20x
 * cheaper on flash.
 */

/** The model returns claims WITHOUT urls; we attach the url we actually fetched. */
const ExtractedClaim = Evidence.omit({ id: true, source_url: true, source_title: true });
const Extraction = z.object({
  claims: z.array(ExtractedClaim),
});

const SYSTEM = `You extract atomic factual claims from a supplied source text.

ABSOLUTE RULES:
- Use ONLY the supplied text. You have no other knowledge for this task.
- If a fact is not in the text, it does not exist. Never supplement from memory.
- One claim per entry. "The storm hit on September 8 and killed 8,000" is TWO
  claims. If an entry contains two dates or two numbers, split it.
- Prefer claims that carry dates, numbers, named people, named institutions and
  quotations. These are what a script needs and what a fact-checker attacks.
- Skip navigational and meta text (see also, references, external links).
- quote: a verbatim span from the supplied text, 25 words or fewer, or null.
  It must appear in the text EXACTLY. Never paraphrase into the quote field.
- confidence "contested" when the text itself signals dispute ("estimates
  range", "some historians argue", "the figure is disputed"). Do not resolve a
  disagreement: record each position as its own contested entry.`;

export async function runEvidenceBase(
  ctx: RunContext,
  input: { treatment: Treatment; maxArticles?: number; claimsPerArticle?: number }
) {
  const maxArticles = input.maxArticles ?? 4;

  return stage({
    ctx,
    name: "evidence_base",
    schema: EvidenceBase,
    gates: [(a) => sufficiency(a, ctx, input.treatment.central_question)],
    produce: async (failures: Failure[]) => {
      const articles = await retrieve(ctx, input.treatment, maxArticles);

      // Bounded, not Promise.all. Beyond rate limits, this is what keeps the
      // spend cap meaningful: concurrent calls all clear the pre-flight budget
      // check before any of them reports its cost, so overshoot is bounded by
      // the concurrency limit rather than by a single call.
      const perArticle = await mapLimit(articles, 2, (article) =>
        extractFrom(ctx, article, input.treatment, failures, input.claimsPerArticle ?? 22)
      );

      // Assign ids after the fact so they are stable and sequential across
      // articles regardless of which extraction call returned first.
      let n = 0;
      const entries = perArticle.flatMap(({ article, claims }) =>
        claims.map((c) => ({
          ...c,
          id: `e${++n}`,
          source_url: article.url,
          source_title: article.title,
        }))
      );

      console.log(
        `    evidence: ${entries.length} entries from ${articles.length} sources ` +
          `(${entries.filter((e) => e.confidence === "contested").length} contested, ` +
          `${entries.filter((e) => e.quote).length} with quotes)`
      );

      return { entries };
    },
  });
}

/* ---------------------------------------------------------------- retrieval */

async function retrieve(ctx: RunContext, t: Treatment, max: number): Promise<Article[]> {
  const hits = await searchArticles(t.topic, 10);
  if (hits.length === 0) throw new Error(`No Wikimedia articles found for topic "${t.topic}"`);

  // Longer articles carry more extractable detail; short stubs and
  // disambiguation pages cost a call and return almost nothing.
  const chosen = hits.filter((h) => h.wordcount > 400).slice(0, max);
  if (chosen.length === 0) {
    throw new Error(
      `Wikimedia returned only stubs for "${t.topic}" (longest ${hits[0]?.wordcount ?? 0} words).\n` +
        `This topic has too thin a text base to ground a script.`
    );
  }

  console.log(`    retrieving ${chosen.length} articles:`);
  const articles: Article[] = [];
  for (const hit of chosen) {
    const article = await fetchArticle(hit.title);
    console.log(
      `      ${article.title} — ${article.text.length} chars, ${article.citations.length} citations`
    );
    articles.push(article);
  }

  // Harvest the real third-party sources these articles cite. Not used to
  // ground claims today (we did not fetch them, so we cannot honestly cite
  // them), but this is the upgrade path to genuine multi-source corroboration.
  const citations = articles.flatMap((a) =>
    a.citations.map((c) => ({ ...c, cited_by: a.url }))
  );
  writeFileSync(
    join(ctx.dir, "candidate_sources.json"),
    JSON.stringify({ count: citations.length, citations }, null, 2) + "\n"
  );
  console.log(`    harvested ${citations.length} candidate third-party sources`);

  return articles;
}

/* --------------------------------------------------------------- extraction */

async function extractFrom(
  ctx: RunContext,
  article: Article,
  t: Treatment,
  failures: Failure[],
  budget: number
) {
  // Cap the text we send. Long articles run past the useful range and the tail
  // is usually references and trivia.
  const text = article.text.slice(0, 60_000);

  const { claims } = await complete({
    model: CHEAP,
    name: "Extraction",
    schema: Extraction,
    runId: ctx.runId,
    stage: "evidence_base",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0.2,
    system: SYSTEM,
    user: [
      `The video's angle: ${t.angle}`,
      `It must answer: ${t.central_question}`,
      "",
      `Extract up to ${budget} claims from the source text below. Favour claims`,
      "relevant to that angle, but include the load-bearing facts of the event",
      "itself (dates, death tolls, named officials) even if tangential to the angle.",
      failures.length
        ? `\nA previous attempt was rejected:\n${failures.map((f) => `- ${f.message}`).join("\n")}`
        : "",
      "",
      `--- SOURCE: ${article.title} ---`,
      text,
      "--- END SOURCE ---",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return { article, claims };
}
