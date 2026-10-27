import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createRun, stage, pass, fail, GateAbort, MAX_ATTEMPTS } from "./pipeline.ts";
import { readTime, countWords } from "./gates/read_time.ts";
import { extractCitations } from "./clients/wikimedia.ts";
import { jsonSchemaFor } from "./schema.ts";
import { EvidenceBase, type Treatment } from "./artifacts.ts";
import { usdFor, WRITER, CHEAP } from "./models.ts";
import { addSpend, getSpend, assertWithinBudget, BudgetExceeded } from "./cost.ts";
import { numberToWords, normalizeWords, diffWords } from "./gates/asr_diff.ts";
import { applyLexicon, canonicalize, collapse, type Lexicon } from "./lexicon.ts";
import { parseWhisperWords } from "./align.ts";
import { notAtomic } from "./gates/sufficiency.ts";

/**
 * Smoke test for the pure machinery: stage caching, the gate retry loop,
 * failure preservation, read_time arithmetic, citation parsing, schema
 * hardening and cost maths.
 *
 * Makes no network calls and spends nothing, so it is safe to run any time.
 *   node src/smoke.ts
 */

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond || !detail ? "" : `\n       ${detail}`}`);
  if (!cond) failed++;
}

const Thing = z.object({ n: z.number(), label: z.string() });

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "vreelr-smoke-"));
  const cwd = process.cwd();
  process.chdir(sandbox);

  console.log("\nstage caching");
  {
    const ctx = createRun("t1");
    let calls = 0;
    const produce = async () => {
      calls++;
      return { n: calls, label: "first" };
    };

    const a = await stage({ ctx, name: "demo", schema: Thing, produce });
    const b = await stage({ ctx, name: "demo", schema: Thing, produce });
    check("producer runs once, second read is cached", calls === 1, `ran ${calls}x`);
    check("cached value is identical", a.n === b.n && b.label === "first");
    check("artifact written to runs/<id>/<stage>.json", existsSync(join(ctx.dir, "demo.json")));

    const forced = createRun("t1", ["demo"]);
    await stage({ ctx: forced, name: "demo", schema: Thing, produce });
    check("--force re-runs the stage", calls === 2, `ran ${calls}x`);
  }

  console.log("\ncached artifact that no longer matches its schema");
  {
    const ctx = createRun("t2");
    writeFileSync(join(ctx.dir, "demo.json"), JSON.stringify({ n: "not a number" }));
    let threw = "";
    try {
      await stage({ ctx, name: "demo", schema: Thing, produce: async () => ({ n: 1, label: "x" }) });
    } catch (e) {
      threw = (e as Error).message;
    }
    check("throws rather than silently regenerating", threw.includes("no longer matches its schema"), threw.slice(0, 90));
    check("names the fix in the error", threw.includes("--force demo"));
  }

  console.log("\ngate retry loop");
  {
    const ctx = createRun("t3");
    let attempts = 0;
    // Fails once, then passes: proves failures are fed back and retried.
    const produce = async (failures: any[]) => {
      attempts++;
      return { n: failures.length, label: attempts === 1 ? "bad" : "good" };
    };
    const gate = (a: z.infer<typeof Thing>) =>
      a.label === "bad"
        ? fail("demogate", [{ code: "bad_label", message: "label must not be bad", offending: a.label }])
        : pass("demogate");

    const out = await stage({ ctx, name: "demo", schema: Thing, produce, gates: [gate] });
    check("retries after a gate failure", attempts === 2, `attempts=${attempts}`);
    check("failures are passed into the retry", out.n === 1, `saw ${out.n} failures`);
    check("passing artifact is written", existsSync(join(ctx.dir, "demo.json")));
  }

  console.log("\ngate abort + failure preservation");
  {
    const ctx = createRun("t4");
    let threw: unknown;
    try {
      await stage({
        ctx,
        name: "demo",
        schema: Thing,
        produce: async () => ({ n: 0, label: "bad" }),
        gates: [(a) => fail("demogate", [{ code: "always", message: "never passes", offending: a.label }])],
      });
    } catch (e) {
      threw = e;
    }
    check("aborts as GateAbort", threw instanceof GateAbort);
    check(`aborts after ${MAX_ATTEMPTS} attempts`, (threw as Error)?.message.includes(String(MAX_ATTEMPTS)));
    check("does NOT write a failing artifact", !existsSync(join(ctx.dir, "demo.json")));

    const preserved = (existsSync("fixtures/failures") ? readdirSync("fixtures/failures") : []).filter(
      (f) => f.startsWith("t4__")
    );
    check(
      `preserves every rejection to fixtures/failures (got ${preserved.length})`,
      preserved.length === MAX_ATTEMPTS,
      preserved.join(", ")
    );
    if (preserved[0]) {
      const f = JSON.parse(readFileSync(join("fixtures/failures", preserved[0]), "utf8"));
      check("preserved file holds the rejected artifact and the reason", !!f.artifact && !!f.failures?.[0]?.message);
      check("preserved file names gate, stage and run", f.gate === "demogate" && f.stage === "demo" && f.run_id === "t4");
    }
  }

  process.chdir(cwd);
  rmSync(sandbox, { recursive: true, force: true });

  console.log("\nread_time arithmetic");
  {
    const t: Treatment = {
      topic: "x",
      angle: "x",
      central_question: "x",
      why_long_form: "x",
      target_runtime_s: 600,
    };
    // 600s at the calibrated 162 wpm = 1620 words.
    const mk = (words: number) => ({ segments: [{ id: "s1", beat_id: "b1", text: "word ".repeat(words).trim(), evidence_ids: [] }] });
    check("counts words", countWords("one two  three\nfour") === 4);
    check("1620 words passes at 600s target", readTime(mk(1620), t).passed);
    check("700 words fails as too short", readTime(mk(700), t).failures[0]?.code === "too_short");
    check("2200 words fails as too long", readTime(mk(2200), t).failures[0]?.code === "too_long");
    check("too_short says how many words to add", /about \d+ more words/.test(readTime(mk(700), t).failures[0]!.message));
  }

  console.log("\ncitation parsing (nested templates)");
  {
    const wikitext = `
Text.<ref>{{cite journal |title=Storm Surge in {{lang|es|Galveston}} |url=https://example.org/a.pdf |journal=J. Climate}}</ref>
More.<ref>{{cite news |title=The Great Storm |url=https://news.example.com/b |newspaper=Houston Chronicle}}</ref>
Book with no url.<ref>{{cite book |title=Isaac's Storm |publisher=Crown}}</ref>
Dup.<ref>{{cite news |title=The Great Storm |url=https://news.example.com/b |newspaper=Houston Chronicle}}</ref>
Relative.<ref>{{cite web |title=Bad |url=/local/path}}</ref>
`;
    const c = extractCitations(wikitext);
    check("finds 2 usable citations", c.length === 2, JSON.stringify(c.map((x) => x.title)));
    check(
      "survives a nested template in the title",
      c[0]?.title === "Storm Surge in Galveston",
      c[0]?.title
    );
    check("maps cite journal to academic", c[0]?.source_type === "academic");
    check("maps cite news to news", c[1]?.source_type === "news");
    check("drops citations with no resolvable url", !c.some((x) => x.title === "Isaac's Storm"));
    check("drops relative urls", !c.some((x) => x.url.startsWith("/")));
    check("de-duplicates by url", c.filter((x) => x.url === "https://news.example.com/b").length === 1);
  }

  console.log("\nschema derivation");
  {
    const rf = jsonSchemaFor("EvidenceBase", EvidenceBase) as any;
    check("uses the Fireworks json_schema envelope", rf.type === "json_schema" && !!rf.json_schema.schema);
    const entry = rf.json_schema.schema.properties.entries.items;
    check("objects are closed", entry.additionalProperties === false);
    check("nullable field is still required", entry.required.includes("quote"));
    check("describe() text reaches the schema", entry.properties.claim.description?.includes("atomic"));
  }

  console.log("\ncost maths");
  {
    const usd = usdFor(WRITER, { input: 1_000_000, cachedInput: 0, output: 0 });
    check("1M uncached input on the writer costs $3.00", Math.abs(usd - 3) < 1e-9, String(usd));
    const cachedUsd = usdFor(WRITER, { input: 1_000_000, cachedInput: 1_000_000, output: 0 });
    check("fully cached input is 10x cheaper", Math.abs(cachedUsd - 0.3) < 1e-9, String(cachedUsd));
    const flash = usdFor(CHEAP, { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
    check("flash 1M in + 1M out costs $0.65", Math.abs(flash - 0.65) < 1e-9, String(flash));
    check("writer output is 30x flash output", WRITER.price.output / CHEAP.price.output === 30);
  }

  console.log("\nnumber spelling (so 8,000 and eight thousand compare equal)");
  {
    check("8000", numberToWords(8000) === "eight thousand", numberToWords(8000));
    check("37000", numberToWords(37000) === "thirty seven thousand", numberToWords(37000));
    check("1900", numberToWords(1900) === "one thousand nine hundred", numberToWords(1900));
    check("145", numberToWords(145) === "one hundred forty five", numberToWords(145));
    check("8", numberToWords(8) === "eight");
  }

  console.log("\nASR normalisation");
  {
    check(
      "numerals expand to words",
      normalizeWords("8,000 died").join(" ") === "eight thousand died",
      normalizeWords("8,000 died").join(" ")
    );
    check(
      "punctuation and case are dropped",
      normalizeWords("On September 8th, the Bureau -- silent!").join(" ").includes("september"),
      normalizeWords("On September 8th, the Bureau -- silent!").join(" ")
    );
    check("empty stays empty", normalizeWords("   ").length === 0);
  }

  console.log("\nword diff");
  {
    const eq = diffWords(["a", "b", "c"], ["a", "b", "c"]);
    check("identical input yields only matches", eq.every((o) => o.kind === "match"));

    const sub = diffWords("the storm hit galveston".split(" "), "the storm hit galvestone".split(" "));
    const subOp = sub.find((o) => o.kind === "sub");
    check("a mispronunciation reads as a substitution", !!subOp, JSON.stringify(sub.map((o) => o.kind)));
    check("substitution keeps both sides", subOp?.expected === "galveston" && subOp?.heard === "galvestone");

    const del = diffWords("eight thousand people died".split(" "), "eight thousand died".split(" "));
    check("a dropped word reads as a deletion", del.some((o) => o.kind === "del" && o.expected === "people"));

    const mangled = diffWords("eight thousand".split(" "), "eighty thousand".split(" "));
    check("mangled number is caught", mangled.some((o) => o.kind === "sub" && o.expected === "eight"));
  }

  console.log("\nlexicon round trip");
  {
    const lex: Lexicon = {
      entries: [
        { term: "Gangoite", respelling: "gan-GOY-tay", note: null },
        { term: "Belen", respelling: "beh-LEN", note: null },
      ],
    };
    const original = "Father Gangoite at the Belen Observatory";
    const { text: spoken, applied } = applyLexicon(original, lex);
    check("substitutes both terms", applied.length === 2, spoken);
    check("spoken form carries the respelling", spoken.includes("gan-GOY-tay") && spoken.includes("beh-LEN"), spoken);
    // what an ASR would plausibly hear from the spoken form
    const heard = "Father gan goy tay at the beh LEN Observatory";
    check(
      "canonicalize restores the original spelling",
      canonicalize(heard, lex).includes("Gangoite") && canonicalize(heard, lex).includes("Belen"),
      canonicalize(heard, lex)
    );
    check("collapse ignores case and punctuation", collapse("gan-GOY-tay") === collapse("Gan Goy Tay"));
    check(
      "a term absent from the text is not reported as applied",
      applyLexicon("no proper nouns here", lex).applied.length === 0
    );
  }

  console.log("\nwhisper output parsing (shape varies by version)");
  {
    const a = parseWhisperWords({
      transcription: [{ words: [{ word: "the", start: 0, end: 0.2 }, { word: "storm", start: 0.2, end: 0.6 }] }],
    });
    check("parses nested words with second offsets", a.length === 2 && a[1]?.text === "storm", JSON.stringify(a));

    const b = parseWhisperWords(
      JSON.stringify({ segments: [{ words: [{ text: "hit", offsets: { from: 1000, to: 1400 } }] }] })
    );
    check("parses a JSON string with ms offsets", b.length === 1 && b[0]?.start_s === 1 && b[0]?.end_s === 1.4, JSON.stringify(b));

    const c = parseWhisperWords({ transcription: [{ text: "fallback", offsets: { from: "00:00:02,000", to: "00:00:02,500" } }] });
    check("falls back to segment text with timestamp strings", c.length === 1 && c[0]?.start_s === 2, JSON.stringify(c));

    check("garbage yields no words rather than throwing", parseWhisperWords("not json at all").length === 0);
  }

  console.log("\nclaim atomicity (regression: this gate once rejected a whole run)");
  {
    // Encyclopedia prose is full of single facts that LOOK compound. An earlier
    // version flagged all of these, which made the gate unsatisfiable — the
    // model was right and the gate was wrong, so no retry could ever pass.
    const atomic = [
      "Isaac Monroe Cline was the chief meteorologist at the Galveston office from 1889 to 1901.",
      "The hurricane made landfall with winds of 140 mph (225 km/h).",
      "The Galveston Seawall was extended between 1904 and 1963.",
      "A ship encountered the storm about 1,160 mi (1,865 km) east of Cape Verde.",
      "A 2008 reanalysis concluded the 1915 depression formed by August 5, 1915.",
      "The 1915 hurricane was the first since the 1900 Galveston hurricane.",
      "Research in 1997 associated either 403 or 405 deaths with the hurricane.",
      "An estimated 8,000 people died in Galveston.",
    ];
    const compound = [
      "The storm hit on September 8, 1900 and the seawall was completed in 1904.",
      "Cline joined in 1889, was transferred in 1901, and retired in 1935.",
      "The death toll was 8,000 and property damage reached 30,000,000 dollars.",
    ];
    const falsePositives = atomic.filter(notAtomic);
    check(`${atomic.length} atomic claims pass`, falsePositives.length === 0, falsePositives.join(" | "));
    const missed = compound.filter((c) => !notAtomic(c));
    check(`${compound.length} compound claims are caught`, missed.length === 0, missed.join(" | "));
  }

  console.log("\nbudget guard");
  {
    const run = "budget-test-" + Date.now();
    check("a fresh run has spent nothing", getSpend(run) === 0);
    addSpend(run, 0.4);
    addSpend(run, 0.3);
    check("spend accumulates", Math.abs(getSpend(run) - 0.7) < 1e-9, String(getSpend(run)));

    let ok = true;
    try {
      assertWithinBudget(run, 1.0);
    } catch {
      ok = false;
    }
    check("under cap does not throw", ok);

    addSpend(run, 0.35);
    let thrown: unknown;
    try {
      assertWithinBudget(run, 1.0);
    } catch (e) {
      thrown = e;
    }
    check("over cap throws BudgetExceeded", thrown instanceof BudgetExceeded);
    check(
      "the error names the spend, the cap and where to look",
      /1\.05|105/.test((thrown as Error)?.message ?? "") &&
        (thrown as Error).message.includes("cost.jsonl"),
      (thrown as Error)?.message?.slice(0, 120)
    );
    check("runs are tracked independently", getSpend("some-other-run") === 0);
  }

  console.log("\nprice table matches the published rates");
  {
    check("flash input $0.15/M", CHEAP.price.input === 0.15);
    check("flash cached input $0.03/M", CHEAP.price.cachedInput === 0.03);
    check("flash output $0.50/M", CHEAP.price.output === 0.5);
    check("kimi-k3 input $3.00/M", WRITER.price.input === 3.0);
    check("kimi-k3 cached input $0.30/M", WRITER.price.cachedInput === 0.3);
    check("kimi-k3 output $15.00/M", WRITER.price.output === 15.0);
    // the real run: 73,373 in / 209,175 out on flash
    const real = usdFor(CHEAP, { input: 73373, cachedInput: 0, output: 209175 });
    check("reproduces the logged evidence_base cost", Math.abs(real - 0.1156) < 0.0005, String(real));
  }

  console.log(failed === 0 ? "\nall checks passed\n" : `\n${failed} CHECK(S) FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
