// Pure helpers shared across the plugin. Kept free of Obsidian imports so they
// can be unit-tested with node directly.

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${t}${r}` : `${t}${r}`;
}

/** Vault naming convention: lowercase-with-hyphens, ASCII only. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip YAML frontmatter; returns body and the offset where the body starts. */
export function splitFrontmatter(text: string): { body: string; offset: number } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (m && m.index === 0) return { body: text.slice(m[0].length), offset: m[0].length };
  return { body: text, offset: 0 };
}

export interface Located {
  start: number;
  end: number;
  exact: boolean;
}

/**
 * Find a quoted span inside `text`. Tries exact match first, then a
 * whitespace/markdown-insensitive match, then a match on the first and last
 * few words. Returns character offsets into `text`.
 */
export function locateQuote(text: string, quote: string): Located | null {
  const q = quote.trim();
  if (!q) return null;
  const idx = text.indexOf(q);
  if (idx >= 0) return { start: idx, end: idx + q.length, exact: true };

  // Tokenise to letters/digits so markdown emphasis, quotes and punctuation
  // glued to a word (e.g. "**Church**,") never break the match.
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const tryWords = (ws: string[]): Located | null => {
    const pattern = ws.map((w) => escapeRegExp(w)).join("[\\s\\S]{0,12}?");
    const re = new RegExp(pattern, "iu");
    const m = re.exec(text);
    if (!m) return null;
    // Keep closing punctuation and emphasis that follow the last word.
    const tail = /^[*_`)\]"'»”]*/.exec(text.slice(m.index + m[0].length))?.[0] ?? "";
    return { start: m.index, end: m.index + m[0].length + tail.length, exact: false };
  };
  const full = tryWords(words);
  if (full) return full;
  if (words.length > 8) {
    const h = tryWords(words.slice(0, 5));
    const t = tryWords(words.slice(-5));
    if (h && t && t.end > h.start && t.end - h.start < q.length * 3) {
      return { start: h.start, end: t.end, exact: false };
    }
  }
  return null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return up to `chars` of context on each side of [start,end), snapped to word boundaries. */
export function contextWindow(
  text: string,
  start: number,
  end: number,
  chars: number,
): { before: string; after: string } {
  let b0 = Math.max(0, start - chars);
  while (b0 > 0 && !/\s/.test(text[b0])) b0--;
  let a1 = Math.min(text.length, end + chars);
  while (a1 < text.length && !/\s/.test(text[a1])) a1++;
  return { before: text.slice(b0, start).trim(), after: text.slice(end, a1).trim() };
}

/** Find `==highlight==` spans in markdown. Spans never cross a blank line. */
export function findMarkdownHighlights(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /==([^=\n](?:(?!\n\s*\n)[\s\S])*?)==/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    if (inner.length < 3) continue;
    out.push({ text: inner, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function lineOf(text: string, offset: number): number {
  let line = 0;
  const n = Math.min(offset, text.length);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Nearest markdown heading above `offset`, if any. */
export function headingAbove(text: string, offset: number): string | null {
  const lines = text.slice(0, offset).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal markdown -> HTML for Anki fields: bold, italics, inline code,
 * line breaks. Cloze markers `{{c1::...}}` are preserved (their bodies are
 * HTML-escaped but the marker syntax is kept intact).
 */
export function inlineMarkdownToHtml(s: string): string {
  const clozes: string[] = [];
  const stash = s.replace(/\{\{c\d+::[\s\S]*?\}\}/g, (m) => {
    clozes.push(m);
    return `\u0000${clozes.length - 1}\u0000`;
  });
  let html = escapeHtml(stash)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const c = clozes[Number(i)];
    return c.replace(/\{\{(c\d+)::([\s\S]*?)\}\}/, (_x, n, body) => `{{${n}::${escapeHtml(body)}}}`);
  });
  return html;
}

/** Render `{{c1::text::hint}}` as readable text for the inbox. */
export function clozeToDisplay(text: string): string {
  return text.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, "[$1]");
}

export function countClozes(text: string): number {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\{\{(c\d+)::/g)) ids.add(m[1]);
  return ids.size;
}

/** Anki tags cannot contain spaces. */
export function ankiTag(s: string): string {
  return s.trim().replace(/\s+/g, "_");
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|pdf)$/i, "");
}

/** Lower-case, punctuation-free text for substring comparisons. */
export function normalizePlain(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Deterministic check that every cloze deletion is really in the highlight.
 * Returns the deletions that are not. Borrowed from Loopback's linter idea:
 * grounding is a rule you can check by counting, so check it rather than
 * trusting the prompt.
 */
export function ungroundedClozes(clozeText: string, highlight: string): string[] {
  const hay = normalizePlain(highlight);
  const out: string[] = [];
  for (const m of clozeText.matchAll(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g)) {
    const body = normalizePlain(m[1]);
    if (body && !hay.includes(body)) out.push(m[1].trim());
  }
  return out;
}

/**
 * Whether a selection can safely be wrapped in ==…== without producing
 * nested or broken highlight markup.
 */
export function canWrapAsHighlight(sel: string): boolean {
  if (/\n\s*\n/.test(sel)) return false;
  const t = sel.trim();
  if (/^==[\s\S]*==$/.test(t)) return false; // already wrapped
  return !t.includes("==");
}

/** Build Anki's plain-text import format (tab-separated with header directives). */
export function buildAnkiTextImport(
  rows: Array<{ notetype: string; deck: string; fields: string[]; tags: string[] }>,
): string {
  const esc = (v: string) => (/[\t"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:3"];
  for (const r of rows) {
    lines.push([r.notetype, r.deck, r.tags.join(" "), ...r.fields].map(esc).join("\t"));
  }
  return lines.join("\n") + "\n";
}
