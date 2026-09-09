// Run with: npm test  (bundles src/util.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let u;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "util.mjs");
  await build({ entryPoints: ["src/util.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  u = await import(pathToFileURL(out).href);
});

test("slugify matches the vault convention", () => {
  assert.equal(u.slugify("My 11-month Journey: Why the real problem isn't the AI"), "my-11-month-journey-why-the-real-problem-isn-t-the-ai");
  assert.equal(u.slugify("Église Catholique"), "eglise-catholique");
});

test("splitFrontmatter strips YAML and reports the offset", () => {
  const raw = "---\ntitle: x\n---\nBody here";
  const { body, offset } = u.splitFrontmatter(raw);
  assert.equal(body, "Body here");
  assert.equal(raw.slice(offset), body);
  assert.deepEqual(u.splitFrontmatter("no fm"), { body: "no fm", offset: 0 });
});

test("locateQuote finds exact, whitespace-variant, and markdown-wrapped spans", () => {
  const text = "The **Catholic Church**, also known as the Roman Catholic Church, is the largest\nChristian church, with 1.27 to 1.41 billion baptized Catholics worldwide.";
  const exact = u.locateQuote(text, "is the largest");
  assert.deepEqual(exact, { start: text.indexOf("is the largest"), end: text.indexOf("is the largest") + 14, exact: true });
  const loose = u.locateQuote(text, "The Catholic Church, also known as the Roman Catholic Church, is the largest Christian church");
  assert.ok(loose && !loose.exact);
  assert.ok(text.slice(loose.start, loose.end).startsWith("The **Catholic Church**"));
  assert.ok(text.slice(loose.start, loose.end).endsWith("Christian church"));
  assert.equal(u.locateQuote(text, "not in the text at all"), null);
});

test("contextWindow snaps to word boundaries", () => {
  const text = "alpha beta gamma delta epsilon zeta";
  const start = text.indexOf("gamma");
  const { before, after } = u.contextWindow(text, start, start + 5, 7);
  assert.equal(before, "alpha beta");
  assert.equal(after, "delta epsilon");
});

test("findMarkdownHighlights ignores spans across blank lines", () => {
  const text = "a ==first one== b\n\n==second\nline== c\n\n==bad\n\nspan==";
  const spans = u.findMarkdownHighlights(text).map((s) => s.text);
  assert.deepEqual(spans, ["first one", "second\nline"]);
});

test("headingAbove and lineOf", () => {
  const text = "# Top\n\ntext\n\n## Section two\n\nmore text";
  const off = text.indexOf("more text");
  assert.equal(u.headingAbove(text, off), "Section two");
  assert.equal(u.lineOf(text, off), 6);
});

test("inlineMarkdownToHtml keeps cloze markers and escapes html", () => {
  const html = u.inlineMarkdownToHtml("The **pope** is {{c1::the bishop of <Rome>}}\nline 2 `x<y`");
  assert.equal(html, "The <b>pope</b> is {{c1::the bishop of &lt;Rome&gt;}}<br>line 2 <code>x&lt;y</code>");
});

test("clozeToDisplay and countClozes", () => {
  assert.equal(u.clozeToDisplay("{{c1::24}} sui iuris and {{c2::23::number}} Eastern"), "[24] sui iuris and [23] Eastern");
  assert.equal(u.countClozes("{{c1::a}} {{c1::b}} {{c2::c}}"), 2);
});

test("buildAnkiTextImport writes directives and quotes fields", () => {
  const out = u.buildAnkiTextImport([
    { notetype: "Basic", deck: "Default", tags: ["recall", "source::x"], fields: ["Q?", 'A "quoted"\tx'] },
  ]);
  const lines = out.trim().split("\n");
  assert.deepEqual(lines.slice(0, 5), ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:3"]);
  assert.equal(lines[5], 'Basic\tDefault\trecall source::x\tQ?\t"A ""quoted""\tx"');
});

test("ankiTag replaces spaces", () => {
  assert.equal(u.ankiTag("two words"), "two_words");
});

test("basenameNoExt strips .md and .pdf", () => {
  assert.equal(u.basenameNoExt("sources/x/Paper (2).pdf"), "Paper (2)");
  assert.equal(u.basenameNoExt("wiki/a.md"), "a");
});

test("ungroundedClozes flags deletions missing from the highlight", () => {
  const hl = "The Catholic Church has 1.3 billion baptized members.";
  assert.deepEqual(u.ungroundedClozes("It has {{c1::1.3 billion}} members, founded in {{c2::AD 33}}.", hl), ["AD 33"]);
  assert.deepEqual(u.ungroundedClozes("{{c1::Catholic Church::hint}}", hl), []);
});

test("canWrapAsHighlight refuses nested or multi-paragraph spans", () => {
  assert.equal(u.canWrapAsHighlight("plain text"), true);
  assert.equal(u.canWrapAsHighlight("==already=="), false);
  assert.equal(u.canWrapAsHighlight("has ==inner== marks"), false);
  assert.equal(u.canWrapAsHighlight("two\n\nparagraphs"), false);
});
