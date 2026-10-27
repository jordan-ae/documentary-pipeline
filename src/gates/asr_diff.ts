import { Narration, Script, type Failure } from "../artifacts.ts";
import { fail, pass, type RunContext } from "../pipeline.ts";
import { canonicalize, loadLexicon } from "../lexicon.ts";

/**
 * asr_diff gate. Pure code, no LLM, per docs/ARCHITECTURE.md.
 *
 * Compares what the voice actually said against what the script said. Catches
 * the three TTS failure modes that matter in historical content: mispronounced
 * proper nouns, dropped words, and mangled numbers.
 *
 * It reuses the word timings already produced by alignment rather than running
 * whisper a second time — those words ARE the transcription of the generated
 * audio, so a second pass would cost minutes to recompute the same thing.
 *
 * Tolerance is asymmetric on purpose. base.en has its own error rate, so a few
 * percent of ordinary-word noise is expected and forgiven. Numbers and proper
 * nouns are not forgiven at all: "eight thousand" heard as "eighty thousand"
 * is exactly the failure that ends the channel.
 */

export type AsrDiffConfig = {
  /** Allowed mismatch rate for ordinary words, absorbing base.en's own error. */
  maxOrdinaryWer: number;
};

const DEFAULTS: AsrDiffConfig = { maxOrdinaryWer: 0.04 };

const NUMBER_WORDS = new Set([
  "zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen",
  "eighteen","nineteen","twenty","thirty","forty","fifty","sixty","seventy",
  "eighty","ninety","hundred","thousand","million","billion",
]);

const ONES = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

/** Spell an integer so "8,000" and "eight thousand" compare equal. */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return (TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "")).trim();
  if (n < 1000) return (ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberToWords(n % 100) : "")).trim();
  for (const [limit, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= limit) {
      return (numberToWords(Math.floor(n / limit)) + ` ${name}` + (n % limit ? " " + numberToWords(n % limit) : "")).trim();
    }
  }
  return String(n);
}

/** Lowercase, drop punctuation, spell out numerals. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/[^a-z0-9'\s.]/g, " ")
    .split(/\s+/)
    .flatMap((tok) => {
      const t = tok.replace(/^['.]+|['.]+$/g, "");
      if (!t) return [];
      if (/^\d+$/.test(t)) return numberToWords(Number(t)).split(" ");
      return [t];
    });
}

type Op = { kind: "match" | "sub" | "del" | "ins"; expected?: string; heard?: string; at: number };

/** Word-level LCS diff. Small inputs, so the quadratic table is fine. */
export function diffWords(expected: string[], heard: string[]): Op[] {
  const n = expected.length;
  const m = heard.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = expected[i] === heard[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i] === heard[j]) {
      ops.push({ kind: "match", expected: expected[i], heard: heard[j], at: i });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", expected: expected[i], at: i });
      i++;
    } else {
      ops.push({ kind: "ins", heard: heard[j], at: i });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", expected: expected[i], at: i++ });
  while (j < m) ops.push({ kind: "ins", heard: heard[j++], at: i });

  // Collapse an adjacent del+ins into a substitution, which is what a
  // mispronunciation actually looks like.
  const merged: Op[] = [];
  for (const op of ops) {
    const prev = merged[merged.length - 1];
    if (op.kind === "ins" && prev?.kind === "del") {
      merged[merged.length - 1] = { kind: "sub", expected: prev.expected, heard: op.heard, at: prev.at };
    } else if (op.kind === "del" && prev?.kind === "ins") {
      merged[merged.length - 1] = { kind: "sub", expected: op.expected, heard: prev.heard, at: op.at };
    } else {
      merged.push(op);
    }
  }
  return merged;
}

export function asrDiff(
  narration: Narration,
  _ctx: RunContext,
  script: Script,
  config: Partial<AsrDiffConfig> = {}
) {
  const cfg = { ...DEFAULTS, ...config };

  if (narration.words.length === 0) {
    return fail("asr_diff", [
      {
        code: "no_alignment",
        message: "Narration has no word timings, so it cannot be diffed against the script.",
        offending: null,
      },
    ]);
  }

  const lex = loadLexicon();
  const scriptText = script.segments.map((s) => s.text).join(" ");

  // Undo the pronunciation respellings before comparing, or the lexicon would
  // manufacture the very mismatches this gate exists to find.
  const heardText = canonicalize(narration.words.map((w) => w.text).join(" "), lex);

  const expected = normalizeWords(scriptText);
  const heard = normalizeWords(heardText);
  const ops = diffWords(expected, heard);

  // Proper nouns: capitalised mid-sentence in the original script.
  const properNouns = new Set(
    (scriptText.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/g) ?? []).map((w) => w.toLowerCase())
  );

  const mismatches = ops.filter((o) => o.kind !== "match");
  const failures: Failure[] = [];

  const isNumber = (w?: string) => !!w && NUMBER_WORDS.has(w);
  const isProper = (w?: string) => !!w && properNouns.has(w);

  const critical = mismatches.filter((o) => isNumber(o.expected) || isNumber(o.heard) || isProper(o.expected));
  const ordinary = mismatches.filter((o) => !critical.includes(o));

  const context = (o: Op) => {
    const from = Math.max(0, o.at - 4);
    return `...${expected.slice(from, o.at).join(" ")} [${o.expected ?? "-"} -> ${o.heard ?? "(dropped)"}] ${expected.slice(o.at + 1, o.at + 5).join(" ")}...`;
  };

  for (const o of critical.slice(0, 12)) {
    const kind = isNumber(o.expected) || isNumber(o.heard) ? "number" : "proper noun";
    failures.push({
      code: o.kind === "del" ? `dropped_${kind.replace(" ", "_")}` : `misread_${kind.replace(" ", "_")}`,
      message:
        o.kind === "del"
          ? `The voice dropped a ${kind}: "${o.expected}".`
          : `The voice read the ${kind} "${o.expected ?? "-"}" as "${o.heard ?? "(nothing)"}". Add it to fixtures/lexicon.json with a respelling.`,
      offending: context(o),
    });
  }

  const wer = ordinary.length / Math.max(1, expected.length);
  if (wer > cfg.maxOrdinaryWer) {
    failures.push({
      code: "high_wer",
      message: `${ordinary.length} ordinary-word mismatches out of ${expected.length} (${(wer * 100).toFixed(1)}%), over the ${(cfg.maxOrdinaryWer * 100).toFixed(0)}% tolerance.`,
      offending: ordinary.slice(0, 5).map(context).join("\n"),
    });
  }

  console.log(
    `      asr_diff: ${expected.length} script words, ${heard.length} heard, ` +
      `${critical.length} critical, ${ordinary.length} ordinary (${(wer * 100).toFixed(1)}% WER)`
  );

  return failures.length ? fail("asr_diff", failures) : pass("asr_diff");
}
