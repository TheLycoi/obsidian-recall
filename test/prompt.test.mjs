// Run with: npm test  (bundles src/prompt.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "prompt.mjs");
  await build({ entryPoints: ["src/prompt.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
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
