import type { SourceType } from "../artifacts.ts";

/**
 * Wikimedia read client. Plain fetch, no SDK, per CLAUDE.md.
 *
 * This exists so the evidence base is built from text we actually retrieved
 * rather than from model memory. A model asked to "research" a topic will
 * produce confident, well-formatted, non-existent source URLs, and the
 * grounding gate would then be checking claims against fabricated rows.
 *
 * Two things come back from here:
 *   - article plain text, which is the ONLY text the evidence stage may read
 *   - the article's own {{cite}} templates, which are real third-party URLs
 *     and give us academic/news sources rather than a single encyclopedia one
 *
 * Wikimedia's policy requires a descriptive User-Agent with contact info.
 * Requests without one are rate-limited or refused outright.
 */

const API = "https://en.wikipedia.org/w/api.php";
const UA = "vreelr/0.1 (documentary research pipeline; https://github.com/vreelr) node-fetch";

async function api(params: Record<string, string>): Promise<any> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`Wikimedia ${res.status} ${res.statusText} for ${url}`);
  }
  const json = (await res.json()) as any;
  if (json.error) {
    throw new Error(`Wikimedia API error: ${JSON.stringify(json.error)}`);
  }
  return json;
}

export type SearchHit = { title: string; pageid: number; wordcount: number };

export async function searchArticles(query: string, limit = 8): Promise<SearchHit[]> {
  const json = await api({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit),
    srnamespace: "0",
  });
  return (json.query?.search ?? []).map((h: any) => ({
    title: h.title,
    pageid: h.pageid,
    wordcount: h.wordcount,
  }));
}

export type Article = {
  title: string;
  url: string;
  /** Full plain-text body. The evidence stage reads only this. */
  text: string;
  /** Real third-party sources cited by the article. */
  citations: Citation[];
};

export type Citation = {
  title: string;
  url: string;
  publisher: string | null;
  source_type: SourceType;
};

export async function fetchArticle(title: string): Promise<Article> {
  const json = await api({
    action: "query",
    prop: "extracts|revisions",
    rvprop: "content",
    rvslots: "main",
    explaintext: "1",
    exsectionformat: "plain",
    redirects: "1",
    titles: title,
  });

  const page = json.query?.pages?.[0];
  if (!page || page.missing) throw new Error(`Wikimedia: no such article "${title}"`);

  const wikitext: string = page.revisions?.[0]?.slots?.main?.content ?? "";

  return {
    title: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    text: page.extract ?? "",
    citations: extractCitations(wikitext),
  };
}

/* ------------------------------------------------------- citation extraction */

const CITE_TYPE_TO_SOURCE: Record<string, SourceType> = {
  journal: "academic",
  book: "academic",
  thesis: "academic",
  conference: "academic",
  news: "news",
  "press release": "news",
  magazine: "news",
  web: "reference",
  report: "reference",
  encyclopedia: "reference",
};

/**
 * Pull {{cite ...}} templates out of wikitext.
 *
 * Templates nest ({{cite web |title={{lang|es|...}} }}), so this scans with a
 * brace counter rather than a regex. A regex here silently truncates every
 * citation that contains a nested template, which is a large minority of them.
 */
export function extractCitations(wikitext: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const lower = wikitext.toLowerCase();

  let i = 0;
  while (i < wikitext.length) {
    const start = lower.indexOf("{{cite", i);
    if (start === -1) break;

    // Walk to the matching close brace.
    let depth = 0;
    let end = -1;
    for (let j = start; j < wikitext.length - 1; j++) {
      if (wikitext[j] === "{" && wikitext[j + 1] === "{") {
        depth++;
        j++;
      } else if (wikitext[j] === "}" && wikitext[j + 1] === "}") {
        depth--;
        j++;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) break;

    const body = wikitext.slice(start + 2, end - 2);
    i = end;

    const cite = parseCite(body);
    if (!cite) continue;
    if (seen.has(cite.url)) continue;
    seen.add(cite.url);
    out.push(cite);
  }

  return out;
}

/** Split a template body on top-level pipes only, so nested templates survive. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === "{" && body[j + 1] === "{") {
      depth++;
      current += "{{";
      j++;
      continue;
    }
    if (c === "}" && body[j + 1] === "}") {
      depth--;
      current += "}}";
      j++;
      continue;
    }
    if (c === "[" && body[j + 1] === "[") {
      depth++;
      current += "[[";
      j++;
      continue;
    }
    if (c === "]" && body[j + 1] === "]") {
      depth--;
      current += "]]";
      j++;
      continue;
    }
    if (c === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

function stripMarkup(s: string): string {
  let out = s;

  // Inline wrapper templates carry the text we want in their last positional
  // argument: {{lang|es|Galveston}} means "Galveston". Deleting the template
  // outright silently truncates every title that uses one, so unwrap instead.
  // Innermost-first, repeated until stable, so nesting resolves.
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => {
      const args = String(body).split("|");
      if (args.length < 2) return ""; // a bare template carries no display text
      // Named arguments are metadata (p=12, lang=es), not display text.
      const positional = args.slice(1).filter((a) => !a.includes("="));
      return positional.length ? positional[positional.length - 1]!.trim() : "";
    });
    if (next === out) break;
    out = next;
  }

  return out
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/''+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCite(body: string): Citation | null {
  const parts = splitTopLevel(body);
  const kind = parts[0]?.trim().toLowerCase().replace(/^cite\s*/, "") ?? "";

  const fields: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = stripMarkup(part.slice(eq + 1));
    if (key && value) fields[key] = value;
  }

  const url = fields.url ?? fields["archive-url"] ?? fields.archiveurl;
  const title = fields.title ?? fields["chapter-title"] ?? fields.chapter;

  // A citation without a resolvable URL cannot be checked by a reader, so it is
  // not usable as evidence here. Book-only citations are dropped on purpose.
  if (!url || !title) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  return {
    title,
    url,
    publisher: fields.publisher ?? fields.work ?? fields.newspaper ?? fields.journal ?? null,
    source_type: CITE_TYPE_TO_SOURCE[kind] ?? "reference",
  };
}
