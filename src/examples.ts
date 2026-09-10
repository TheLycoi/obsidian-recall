import type { Card, Highlight } from "./model";

/**
 * Style examples drawn from the reader's own triage decisions across the
 * whole inbox.
 *
 * Deliberately Obsidian-free and store-free: it takes a plain `Highlight[]`
 * rather than the `InboxStore`, so `test/*.test.mjs` can bundle it standalone
 * with esbuild the way the linter is bundled (see the harness in
 * `test/prompt.test.mjs:10-16`). Its only import is a type from `./model`,
 * whose own closure is `./util`, so the bundle stays clean.
 *
 * This is a different mechanism from the per-highlight "these cards already
 * exist for this highlight" block in `llm.ts`. That one is anti-duplication
 * and scoped to one highlight; this one is scoped to the whole inbox and
 * carries no facts at all.
 */

const MAX_POSITIVE = 6;
const MAX_NEGATIVE = 4;
const DEFAULT_MAX_CHARS = 1200;

const POSITIVE_HEADER =
  "Cards this reader kept, from earlier highlights in their notes. They show how this reader words a question and how far they trim an answer. They are style examples and nothing more: the facts in them belong to other passages, and none of them may appear in what you write now. Every card you write comes from the current highlight alone.";

const NEGATIVE_HEADER = "Cards this reader deleted. Write cards unlike these.";

/** `qa | front | back` and `cloze | text`, matching how cards are shown elsewhere in the prompts. */
function renderCard(c: Card): string {
  return c.kind === "qa" ? `qa | ${c.front} | ${c.back}` : `cloze | ${c.text}`;
}

/**
 * Most recent first. `createdAt` is written by `makeCard` as
 * `new Date().toISOString()` (src/model.ts:136), a fixed-width UTC format, so
 * a plain descending string compare is a chronological sort. A card missing
 * the field (an older file) sorts last rather than throwing.
 */
function byNewestFirst(a: Card, b: Card): number {
  const x = a.createdAt ?? "";
  const y = b.createdAt ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

/**
 * Build the history-examples block, or `""` when the reader has made no
 * decisions yet — the common case on a fresh inbox, which must add nothing to
 * the prompt at all, not even a blank line.
 *
 * `maxChars` caps the rendered block. Whole examples are dropped to stay
 * under it, from the end of each list (so the oldest go first); a card is
 * never truncated mid-text, because half a card is a malformed example.
 */
export function buildExamplesBlock(highlights: Highlight[], maxChars: number = DEFAULT_MAX_CHARS): string {
  const positive: Card[] = [];
  const negative: Card[] = [];
  for (const h of highlights ?? []) {
    for (const c of h.cards ?? []) {
      if (c.status === "deleted") negative.push(c);
      else if (c.status === "exported" || c.edited === true) positive.push(c);
    }
  }
  if (!positive.length && !negative.length) return "";

  const positiveLines = positive.sort(byNewestFirst).slice(0, MAX_POSITIVE).map(renderCard);
  const negativeLines = negative.sort(byNewestFirst).slice(0, MAX_NEGATIVE).map(renderCard);

  // Grow the block a line at a time, positives first, and stop each section
  // the moment the next whole card would break the cap.
  let block = "";
  const fits = (candidate: string): boolean => candidate.length <= maxChars;

  for (const line of positiveLines) {
    const candidate = block ? `${block}\n${line}` : `${POSITIVE_HEADER}\n${line}`;
    if (!fits(candidate)) break;
    block = candidate;
  }

  let negativeStarted = false;
  for (const line of negativeLines) {
    const prefix = block ? `${block}\n\n` : "";
    const candidate = negativeStarted ? `${block}\n${line}` : `${prefix}${NEGATIVE_HEADER}\n${line}`;
    if (!fits(candidate)) break;
    block = candidate;
    negativeStarted = true;
  }

  return block;
}
