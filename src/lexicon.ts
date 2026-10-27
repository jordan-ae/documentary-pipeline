import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Script } from "./artifacts.ts";
import { complete } from "./clients/fireworks.ts";
import { CHEAP } from "./models.ts";
import type { RunContext } from "./pipeline.ts";

/**
 * Proper-noun pronunciation lexicon, applied BEFORE synthesis per
 * docs/ARCHITECTURE.md. Mispronounced names are the main TTS failure mode in
 * historical content and the thing the audience for history notices first.
 *
 * The substitution has to be reversible. If "Gangoite" is spoken as
 * "gan-GOY-tay", the ASR transcribes the phonetic form, which would then fail
 * asr_diff against the original script — the lexicon would manufacture the
 * very failures the gate exists to catch. So every substitution is recorded
 * and `canonicalize` maps the spoken form back before diffing.
 */

export const LEXICON_PATH = join("fixtures", "lexicon.json");

export const LexEntry = z.object({
  term: z.string().describe("The proper noun exactly as it appears in the script."),
  respelling: z
    .string()
    .describe(
      "Phonetic respelling for a TTS engine, hyphen-separated with the stressed " +
        "syllable capitalised. Example: Gangoite -> gan-GOY-tay."
    ),
  note: z.string().nullable().describe("Why it needs respelling, or null."),
});
export type LexEntry = z.infer<typeof LexEntry>;

export const Lexicon = z.object({ entries: z.array(LexEntry) });
export type Lexicon = z.infer<typeof Lexicon>;

export function loadLexicon(): Lexicon {
  if (!existsSync(LEXICON_PATH)) return { entries: [] };
  const parsed = Lexicon.safeParse(JSON.parse(readFileSync(LEXICON_PATH, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `${LEXICON_PATH} does not match the Lexicon schema.\n` +
        JSON.stringify(parsed.error.issues, null, 2)
    );
  }
  return parsed.data;
}

/** Collapse to comparable letters: lowercase, letters only. */
export function collapse(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

/** Whole-word, case-insensitive, longest-first so "San Francisco" beats "San". */
function sorted(entries: LexEntry[]): LexEntry[] {
  return [...entries].sort((a, b) => b.term.length - a.term.length);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite script text into what the TTS engine should actually read. */
export function applyLexicon(
  text: string,
  lex: Lexicon
): { text: string; applied: LexEntry[] } {
  let out = text;
  const applied: LexEntry[] = [];

  for (const e of sorted(lex.entries)) {
    const re = new RegExp(`\\b${escapeRe(e.term)}\\b`, "gi");
    if (re.test(out)) {
      out = out.replace(re, e.respelling);
      applied.push(e);
    }
  }

  return { text: out, applied };
}

/**
 * Undo the substitution on an ASR transcript so asr_diff compares like with
 * like. Matching is done on collapsed letters because ASR will render
 * "gan-GOY-tay" as "gan goy tay", "GanGoyTay", or similar.
 */
export function canonicalize(asrText: string, lex: Lexicon): string {
  let out = asrText;

  for (const e of sorted(lex.entries)) {
    const target = collapse(e.respelling);
    if (!target) continue;

    // Slide a window over word runs and replace any run whose collapsed form
    // equals the collapsed respelling.
    const words = out.split(/(\s+)/);
    const maxRun = Math.min(6, words.length);

    for (let runLen = maxRun; runLen >= 1; runLen--) {
      for (let i = 0; i + runLen * 2 - 1 <= words.length; i += 2) {
        const slice = words.slice(i, i + runLen * 2 - 1);
        if (collapse(slice.join("")) === target) {
          words.splice(i, runLen * 2 - 1, e.term);
          out = words.join("");
          break;
        }
      }
    }
  }

  return out;
}

/* ------------------------------------------------------- proposing entries */

const Proposal = z.object({ entries: z.array(LexEntry) });

const SYSTEM = `You identify proper nouns that a text-to-speech engine will mispronounce.

Flag ONLY names a general-purpose English TTS voice is likely to get wrong:
- non-English surnames and place names (Gangoite, Belen, Baqubah)
- names whose spelling misleads (Worcester, Beauchamp, Isaac Cline is fine)
- archaic or unusual spellings
- initialisms that must be spelled out rather than read as a word

Do NOT flag ordinary English names or words a TTS engine handles correctly.
An over-full lexicon makes narration worse, not better.

respelling format: hyphen-separated syllables, stressed syllable in CAPS.
It must be pronounceable by an English TTS voice reading it literally.`;

/**
 * Ask the cheap model which proper nouns are risky, and write the proposal to
 * the run for human review. Deliberately NOT applied automatically: a wrong
 * respelling makes a name worse, and this is exactly the kind of judgment
 * DECISIONS.md #10 keeps a human on.
 */
export async function proposeLexicon(ctx: RunContext, script: Script): Promise<LexEntry[]> {
  const text = script.segments.map((s) => s.text).join("\n\n");

  const { entries } = await complete({
    model: CHEAP,
    name: "LexiconProposal",
    schema: Proposal,
    runId: ctx.runId,
    stage: "narration",
    costLog: ctx.costLog,
        budgetUsd: ctx.budgetUsd,
    temperature: 0,
    system: SYSTEM,
    user: `Script:\n\n${text}`,
  });

  const existing = new Set(loadLexicon().entries.map((e) => collapse(e.term)));
  const novel = entries.filter((e) => !existing.has(collapse(e.term)));

  writeFileSync(
    join(ctx.dir, "lexicon_proposal.json"),
    JSON.stringify({ entries: novel }, null, 2) + "\n"
  );

  return novel;
}
