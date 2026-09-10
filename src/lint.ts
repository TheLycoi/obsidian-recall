// Deterministic post-generation linter. No model call, no network call: every
// check here is a regular expression or a word count, run against text the
// writer already produced. Obsidian-free by design — test/lint.test.mjs
// bundles this module standalone with esbuild, so an `obsidian` import (or an
// import of anything that pulls one in, e.g. settings.ts) breaks `npm test`
// loudly at the esbuild resolve step.
import { normalizePlain, ungroundedClozes } from "./util";
import type { Card, Highlight, LintFailureId, LintWarningId } from "./model";

export interface LintResult {
  failures: LintFailureId[];
  warnings: LintWarningId[];
}

/** Split on whitespace after trimming; empty tokens (blank input) are dropped. */
function words(s: string): string[] {
  return s
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Cloze markers stripped down to their body content, i.e. what the reader sees. */
function clozeVisibleText(text: string): string {
  return text.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, "$1");
}

/** A linking verb, relative pronoun, or causal connector inside a cloze body marks a clause, not an atom. */
const FRAMING_MARKERS = /\b(is|are|was|were|which|that|because|since|due to|such as|who)\b/i;

/** A front that starts this way invites a bare yes/no answer instead of recall. */
const QA_YES_NO_START = /^(is|are|was|were|does|do|did|can|will|should|has|have)\b/i;

export function lintCard(card: Card, highlight: Highlight, siblings: Card[]): LintResult {
  const failures: LintFailureId[] = [];
  const warnings: LintWarningId[] = [];

  if (card.kind === "cloze") {
    // cloze-not-grounded: every {{cN::body}} must appear in the highlight
    // after normalization. Reuses the existing check as-is.
    if (ungroundedClozes(card.text, highlight.text).length > 0) {
      failures.push("cloze-not-grounded");
    }

    const deletions: { n: number; body: string }[] = [];
    for (const m of card.text.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/g)) {
      deletions.push({ n: Number(m[1]), body: m[2] });
    }
    const distinctNumbers = [...new Set(deletions.map((d) => d.n))].sort((a, b) => a - b);

    // cloze-count: counts DISTINCT deletion numbers, not raw {{cN::}} matches.
    // {{c1::a}} ... {{c1::b}} is one deletion tested in two places (a
    // legitimate overlapping-cloze pattern), not two deletions. 1 to 3
    // distinct numbers inclusive.
    if (distinctNumbers.length < 1 || distinctNumbers.length > 3) {
      failures.push("cloze-count");
    }

    // cloze-numbering: distinct numbers are exactly 1..k, no gaps.
    let numberingOk = distinctNumbers.length > 0;
    for (let i = 0; i < distinctNumbers.length; i++) {
      if (distinctNumbers[i] !== i + 1) {
        numberingOk = false;
        break;
      }
    }
    if (!numberingOk) failures.push("cloze-numbering");

    // cloze-framing: each deletion body <=6 words and free of framing markers.
    let framingOk = true;
    for (const d of deletions) {
      if (words(d.body).length > 6 || FRAMING_MARKERS.test(d.body)) {
        framingOk = false;
        break;
      }
    }
    if (!framingOk) failures.push("cloze-framing");

    // qa-empty (cloze variant): text must contain at least one {{cN:: marker.
    if (deletions.length === 0) failures.push("qa-empty");
  } else {
    // qa-empty (qa variant): front and back both non-empty after trim.
    if (card.front.trim().length === 0 || card.back.trim().length === 0) {
      failures.push("qa-empty");
    }
    // qa-answer-long: back <=12 words.
    if (words(card.back).length > 12) failures.push("qa-answer-long");
    // qa-yes-no: front must not start with a yes/no auxiliary.
    if (QA_YES_NO_START.test(card.front.trim())) failures.push("qa-yes-no");
    // answer-in-question: normalized back must not be a substring of normalized front.
    const nFront = normalizePlain(card.front);
    const nBack = normalizePlain(card.back);
    if (nBack.length > 0 && nFront.includes(nBack)) failures.push("answer-in-question");
  }

  // card-long: front + back + text combined <=60 words. Cloze text is
  // counted with markers stripped to their body content, i.e. what the
  // reader sees, not the {{cN::...}} markup.
  const visibleText = card.kind === "cloze" ? clozeVisibleText(card.text) : card.text;
  const totalWords = words(card.front).length + words(card.back).length + words(visibleText).length;
  if (totalWords > 60) failures.push("card-long");

  // duplicate-card: this card's normalized front (qa) or normalized text
  // (cloze) equals that of any sibling of the same kind. Checked against
  // `siblings` only, per the three-parameter signature — the pipeline
  // wiring stage (out of scope here) is responsible for passing any other
  // cards that should count as duplicates.
  const ownKey = normalizePlain(card.kind === "cloze" ? card.text : card.front);
  const isDuplicate = siblings.some((s) => {
    if (s.kind !== card.kind) return false;
    const sKey = normalizePlain(s.kind === "cloze" ? s.text : s.front);
    return sKey.length > 0 && sKey === ownKey;
  });
  if (isDuplicate) warnings.push("duplicate-card");

  // shared-answer: qa only. Normalized back equals the normalized back of
  // any sibling qa card (interference risk).
  if (card.kind === "qa") {
    const nBack = normalizePlain(card.back);
    const isShared = siblings.some((s) => s.kind === "qa" && nBack.length > 0 && normalizePlain(s.back) === nBack);
    if (isShared) warnings.push("shared-answer");
  }

  return { failures, warnings };
}

/** Short human label per id, for the inbox badge. */
export const LINT_LABELS: Record<LintFailureId | LintWarningId, string> = {
  "cloze-not-grounded": "not grounded",
  "cloze-count": "cloze count",
  "cloze-numbering": "cloze numbering",
  "cloze-framing": "cloze framing",
  "qa-empty": "empty",
  "qa-answer-long": "answer too long",
  "qa-yes-no": "yes/no question",
  "card-long": "card too long",
  "answer-in-question": "answer in question",
  "duplicate-card": "duplicate",
  "shared-answer": "shared answer",
};
