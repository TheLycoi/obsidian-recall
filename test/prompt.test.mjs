// Run with: npm test  (bundles src/prompt.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
// The digest and Ask schemas live in src/schemas.ts (zod only, no backends and
// so no `obsidian`), which is why they can be bundled here the same way.
let schemas;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "prompt.mjs");
  await build({ entryPoints: ["src/prompt.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
  const schemaOut = path.join(dir, "schemas.mjs");
  await build({ entryPoints: ["src/schemas.ts"], bundle: true, format: "esm", platform: "node", outfile: schemaOut, logLevel: "silent" });
  schemas = await import(pathToFileURL(schemaOut).href);
});

const base = {
  noteTitle: "Lecture 3",
  body: "Insulin lowers blood glucose.",
  transcript: null,
  maxSpans: 12,
  standingInstructions: "",
  instruction: "",
};

const TRANSCRIPT_LIMIT =
  "The transcript is a recording of the lecture that accompanies this note. Select at most 12 spans, and fewer when the transcript supports fewer.";

test("without a transcript the message has no transcript block and the plain limit", () => {
  const msg = p.buildHighlighterMessage({ ...base });
  assert.ok(!msg.includes("<transcript>"), "should not contain a transcript block");
  assert.ok(msg.includes("Select at most 12 spans."), "should carry the plain limit line");
  assert.ok(!msg.includes(TRANSCRIPT_LIMIT), "should not carry the transcript limit line");
});

test("with a transcript the note comes first, then the transcript, then the limit", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "The lecturer said insulin matters." });
  const note = msg.indexOf("<note");
  const transcript = msg.indexOf("<transcript>");
  const limit = msg.indexOf("Select at most");
  assert.ok(note !== -1 && transcript !== -1 && limit !== -1, "all three blocks are present");
  assert.ok(note < transcript, "note precedes transcript");
  assert.ok(transcript < limit, "transcript precedes the limit line");
  assert.ok(msg.includes(TRANSCRIPT_LIMIT), "should carry the transcript limit line");
  assert.ok(msg.includes("The lecturer said insulin matters."), "transcript text is included");
});

test("instruction lines follow the limit, standing before per-note, and vanish when blank", () => {
  const msg = p.buildHighlighterMessage({
    ...base,
    standingInstructions: "prefer definitions",
    instruction: "only section 2",
  });
  const limit = msg.indexOf("Select at most");
  const standing = msg.indexOf("Standing instructions: prefer definitions");
  const perNote = msg.indexOf("Instructions for this note: only section 2");
  assert.ok(standing > limit, "standing instructions follow the limit line");
  assert.ok(perNote > standing, "per-note instructions follow the standing instructions");

  const bare = p.buildHighlighterMessage({ ...base, standingInstructions: "  ", instruction: "" });
  assert.ok(!bare.includes("Standing instructions:"), "blank standing instructions are omitted");
  assert.ok(!bare.includes("Instructions for this note:"), "blank per-note instructions are omitted");
});

test("a whitespace-only transcript counts as absent", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "   \n" });
  assert.ok(!msg.includes("<transcript>"), "whitespace-only transcript adds no block");
  assert.ok(msg.includes("Select at most 12 spans."), "falls back to the plain limit line");
});

test("blocks are separated by a blank line", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "spoken words" });
  assert.ok(msg.includes("</note>\n\n<transcript>"), "note and transcript are joined by a blank line");
  assert.ok(msg.includes("</transcript>\n\nThe transcript is a recording"), "transcript and limit are joined by a blank line");
});

// --- digest message ---------------------------------------------------------

const digestBase = {
  pdfTitle: "HBIO 250 - Pharmacology",
  classCode: "HBIO250",
  paperText: "[page 1]\nPharmacology, Pharmacodynamics and Pharmacokinetics",
  highlights: [
    { id: "H01", page: 2, text: "Pharmacology is the study of the action of drugs." },
    { id: "H02", page: 4, text: "Receptors bind ligands with high affinity." },
  ],
  existingTitles: ["Pharmacology"],
  maxNotes: 6,
  standingInstructions: "",
  instruction: "",
};

test("digest blocks run paper, highlights, existing notes, then the limit", () => {
  const msg = p.buildDigestMessage({ ...digestBase });
  const paper = msg.indexOf("<paper");
  const highlights = msg.indexOf("<highlights>");
  const existing = msg.indexOf("<existing_notes>");
  const limit = msg.indexOf("Write at most 6 topic notes.");
  assert.ok(paper !== -1 && highlights !== -1 && existing !== -1 && limit !== -1, "all four blocks are present");
  assert.ok(paper < highlights, "paper precedes highlights");
  assert.ok(highlights < existing, "highlights precede existing notes");
  assert.ok(existing < limit, "existing notes precede the limit line");
  assert.ok(msg.includes('<paper title="HBIO 250 - Pharmacology" class="HBIO250">'), "paper block carries title and class");
});

test("an empty paper drops the paper block and keeps the rest", () => {
  const msg = p.buildDigestMessage({ ...digestBase, paperText: "   \n" });
  assert.ok(!msg.includes("<paper"), "whitespace-only paper text adds no block");
  assert.ok(msg.startsWith("<highlights>"), "the highlights block leads instead");
  assert.ok(msg.includes("Write at most 6 topic notes."), "the limit line survives");
});

test("every highlight carries its id and page, text-less ones included", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    highlights: [...digestBase.highlights, { id: "H03", page: 9, text: "" }],
  });
  assert.ok(msg.includes('<highlight id="H01" page="2">Pharmacology is the study of the action of drugs.</highlight>'));
  assert.ok(msg.includes('<highlight id="H02" page="4">Receptors bind ligands with high affinity.</highlight>'));
  assert.ok(msg.includes('<highlight id="H03" page="9"></highlight>'), "a text-less highlight is still listed");
});

test("existing notes are one title per line and the block vanishes when empty", () => {
  const msg = p.buildDigestMessage({ ...digestBase, existingTitles: ["Pharmacology", "Receptors"] });
  assert.ok(msg.includes("<existing_notes>\nPharmacology\nReceptors\n</existing_notes>"), "one title per line");

  const bare = p.buildDigestMessage({ ...digestBase, existingTitles: [] });
  assert.ok(!bare.includes("<existing_notes>"), "no existing titles adds no block");
});

test("digest instruction lines follow the limit, standing before per-PDF, and vanish when blank", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    standingInstructions: "keep summaries tight",
    instruction: "ignore the review slides",
  });
  const limit = msg.indexOf("Write at most 6 topic notes.");
  const standing = msg.indexOf("Standing instructions: keep summaries tight");
  const perPdf = msg.indexOf("Instructions for this PDF: ignore the review slides");
  assert.ok(standing > limit, "standing instructions follow the limit line");
  assert.ok(perPdf > standing, "per-PDF instructions follow the standing instructions");

  const bare = p.buildDigestMessage({ ...digestBase, standingInstructions: "  ", instruction: "" });
  assert.ok(!bare.includes("Standing instructions:"), "blank standing instructions are omitted");
  assert.ok(!bare.includes("Instructions for this PDF:"), "blank per-PDF instructions are omitted");
});

// --- ask message ------------------------------------------------------------

const askBase = {
  question: "What distinguishes a receptor from albumin?",
  evidence: [
    { n: 1, noteTitle: "Pharmacology", page: 2, text: "Pharmacology is the study of the action of drugs." },
    { n: 2, noteTitle: "Receptors", page: 4, text: "Receptors transduce a signal to produce a biological effect." },
  ],
  history: [],
  standingInstructions: "",
};

test("ask puts the evidence first and the question last", () => {
  const msg = p.buildAskMessage({ ...askBase });
  const evidence = msg.indexOf("<evidence>");
  const question = msg.indexOf("Question: ");
  assert.ok(evidence !== -1 && question !== -1, "both blocks are present");
  assert.ok(evidence < question, "evidence precedes the question");
  assert.ok(msg.trimEnd().endsWith("Question: What distinguishes a receptor from albumin?"), "the question is the last block");
});

test("an evidence line reads [n] (Note title, p.N) text", () => {
  const msg = p.buildAskMessage({ ...askBase });
  assert.ok(
    msg.includes("[2] (Receptors, p.4) Receptors transduce a signal to produce a biological effect."),
    "numbered, with the note title and page in parentheses",
  );
});

test("a null page drops the page from the evidence line", () => {
  const msg = p.buildAskMessage({
    ...askBase,
    evidence: [{ n: 1, noteTitle: "Stages of Change", page: null, text: "Decisional balance weighs pros against cons." }],
  });
  assert.ok(msg.includes("[1] (Stages of Change) Decisional balance weighs pros against cons."), "no page, no comma");
  assert.ok(!msg.includes("p."), "no page marker is written");
});

test("history sits between the evidence and the question and vanishes when empty", () => {
  const msg = p.buildAskMessage({
    ...askBase,
    history: [
      { role: "user", text: "What is a receptor?" },
      { role: "assistant", text: "Something that binds a ligand [1]." },
    ],
  });
  const evidence = msg.indexOf("<evidence>");
  const history = msg.indexOf("<history>");
  const question = msg.indexOf("Question: ");
  assert.ok(evidence < history, "evidence precedes history");
  assert.ok(history < question, "history precedes the question");
  assert.ok(msg.includes("User: What is a receptor?"), "user turns are labelled");
  assert.ok(msg.includes("Assistant: Something that binds a ligand [1]."), "assistant turns are labelled");

  const bare = p.buildAskMessage({ ...askBase });
  assert.ok(!bare.includes("<history>"), "an empty history adds no block");
});

test("ask puts standing instructions after the transcript blocks and before the question", () => {
  const withHistory = p.buildAskMessage({
    ...askBase,
    history: [{ role: "user", text: "What is a receptor?" }],
    standingInstructions: "Answer in Dutch.",
  });
  const history = withHistory.indexOf("<history>");
  const standing = withHistory.indexOf("Standing instructions: Answer in Dutch.");
  const question = withHistory.indexOf("Question: ");
  assert.ok(standing !== -1, "the standing block is present");
  assert.ok(history < standing, "standing instructions follow the history");
  assert.ok(standing < question, "standing instructions precede the question");

  const noHistory = p.buildAskMessage({ ...askBase, standingInstructions: "Answer in Dutch." });
  assert.ok(!noHistory.includes("<history>"), "no history block when there are no turns");
  assert.ok(
    noHistory.indexOf("<evidence>") < noHistory.indexOf("Standing instructions:"),
    "without a history the standing block follows the evidence",
  );
  assert.ok(
    noHistory.indexOf("Standing instructions:") < noHistory.indexOf("Question: "),
    "and still precedes the question",
  );

  const blank = p.buildAskMessage({ ...askBase, standingInstructions: "   " });
  assert.ok(!blank.includes("Standing instructions:"), "blank standing instructions are omitted");
});

// --- schemas ----------------------------------------------------------------

test("DigestOut accepts a well-formed draft and rejects a note without highlight_ids", () => {
  const ok = schemas.DigestOut.safeParse({
    notes: [{ title: "T", summary: "S", highlight_ids: ["H01"], related: [] }],
    unused_ids: [],
  });
  assert.equal(ok.success, true, "a complete note parses");

  const missing = schemas.DigestOut.safeParse({ notes: [{ title: "T", summary: "S", related: [] }], unused_ids: [] });
  assert.equal(missing.success, false, "highlight_ids is required, not optional");

  const noUnused = schemas.DigestOut.safeParse({ notes: [] });
  assert.equal(noUnused.success, false, "unused_ids is required too");
});

test("AskOut accepts an answer with its citations and rejects a missing field", () => {
  const ok = schemas.AskOut.safeParse({ answer: "a [1]", cited: [1] });
  assert.equal(ok.success, true, "an answer with cited numbers parses");
  assert.deepEqual(ok.data, { answer: "a [1]", cited: [1] });

  assert.equal(schemas.AskOut.safeParse({ answer: "a [1]" }).success, false, "cited is required");
  assert.equal(schemas.AskOut.safeParse({ answer: "a", cited: ["1"] }).success, false, "cited holds numbers, not strings");
});
