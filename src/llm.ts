import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicBackend } from "./anthropic";
import type { LlmBackend } from "./backend";
import { CodexBackend, CodexError } from "./codex";
import { buildExamplesBlock } from "./examples";
import type { BloomLevel, Card, Highlight } from "./model";
import { buildHighlighterMessage } from "./prompt";
import type { RecallSettings } from "./settings";

const CardOut = z.object({
  kind: z.enum(["qa", "cloze"]).describe("qa for a question with a short answer; cloze for one sentence with hidden spans"),
  front: z
    .string()
    .describe("qa only: the question, naming its subject so it is answerable without the source. Empty string for cloze."),
  back: z.string().describe("qa only: the answer as a term, number, name, or short phrase. Empty string for cloze."),
  text: z
    .string()
    .describe("cloze only: one sentence from the highlight with {{c1::...}} deletions. Empty string for qa."),
});
const CardsOut = z.object({ cards: z.array(CardOut) });
const HighlightsOut = z.object({
  highlights: z.array(
    z.object({
      quote: z.string().describe("Verbatim span copied exactly from the note, character for character."),
      title: z.string().describe("Label of at most six words for this span."),
    }),
  ),
});

export type CardDraft = z.infer<typeof CardOut>;

/**
 * One verdict per drafted card, from the critique pass.
 *
 * Flat and strict on purpose: the Codex backend writes this schema to
 * `--output-schema` (src/codex.ts:366), which runs strict and rejects unions
 * and optional fields, so `front`/`back`/`text` are sentinel empty strings
 * rather than optionals, exactly as `CardOut` above does it.
 *
 * The `bloom` members must stay identical to `BloomLevel` in src/model.ts;
 * `bloomLevelsInSync` below is the compile-time guard on that.
 */
const VerdictOut = z.object({
  index: z.number().int().describe("0-based index of the card being judged, as numbered in the list."),
  verdict: z
    .enum(["keep", "revise", "drop"])
    .describe("keep: use the card as drafted. revise: replace it with the fields below. drop: flag it for the reader."),
  reason: z.string().describe("One sentence, written to the reader, saying what is wrong with this card."),
  bloom: z
    .enum(["remember", "understand", "apply", "analyze", "evaluate", "create"])
    .describe("Bloom's level this card actually sits at, reported for every verdict."),
  kind: z.enum(["qa", "cloze"]).describe("The revised card's kind; echo the original's kind for keep and drop."),
  front: z.string().describe("revise + qa only: the corrected question. Empty string otherwise."),
  back: z.string().describe("revise + qa only: the corrected answer. Empty string otherwise."),
  text: z.string().describe("revise + cloze only: the corrected sentence with {{c1::...}} deletions. Empty string otherwise."),
});
const VerdictsOut = z.object({ verdicts: z.array(VerdictOut) });

export type CritiqueVerdict = z.infer<typeof VerdictOut>;

/**
 * Compile-time guard: assignable both ways, so adding, removing or renaming a
 * member on either side is a type error here rather than a silent drift
 * between what the critique returns and what `Card.bloom` can hold.
 */
type BloomInSync = CritiqueVerdict["bloom"] extends BloomLevel
  ? BloomLevel extends CritiqueVerdict["bloom"]
    ? true
    : never
  : never;
const bloomLevelsInSync: BloomInSync = true;
void bloomLevelsInSync;

/**
 * Card-writer system prompt. Grounded in Wozniak's twenty rules of formulating
 * knowledge (minimum information, cloze, sets and enumerations, interference,
 * wording, context cues, redundancy) and Matuschak's five properties of a good
 * prompt (focused, precise, consistent, tractable, effortful).
 */
const WRITER_SYSTEM = `You write spaced-repetition flashcards for a reader who highlighted one passage in their own notes because they want to remember it. Each card lands in an inbox where the reader keeps, edits, or deletes it before it reaches Anki. A wrong card costs more than a missing one, and a card the reader would delete is wasted review time, so write fewer, better cards.

<what_to_test>
Test only what the highlight itself states. The surrounding context is there to resolve pronouns, abbreviations, and references and to tell you the subject; it is not a source of answers. Do not add outside knowledge, and keep answers close to the highlight's own wording so the reader can verify each card against the text at a glance.

Choose the facts a learner will want to retrieve later: definitions, mechanisms, causes and their effects, numbers, names, dates, and the distinctions between similar things. Skip framing sentences, the author's asides, and facts too obvious to deserve a review. If the highlight contains one fact, write one card; if it contains nothing worth testing, return an empty list. A rule outlasts an instance: when the highlight explains why or how, the card should test the reason, not only the example.
</what_to_test>

<how_to_write>
Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A highlight with several facts becomes several cards, not one card with a paragraph answer. Long answers are the most common defect; when an answer runs past a short phrase, split the card or move the explanation into the question's framing.

Answerable in isolation. Name the subject in the question ("What does decisional balance weigh?", not "What does it weigh?"). The reader will meet this card months from now, shuffled among cards from other notes.

Precise, with one correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Avoid yes/no questions and questions whose wording gives the answer away. Prefer what, which, how, why, when, and how many.

Optimized wording. Use the shortest question that points at the right memory. Cut words that do not disambiguate.

Sets and enumerations. Do not ask for an unordered list of more than three items as a single answer; such cards are nearly unlearnable. Split the list across cards, ask what distinguishes each member, or use overlapping cloze deletions so each card hides one or two members with the rest visible. Test an ordered sequence with cloze cards that hide one step and show its neighbours.

Interference. When the highlight distinguishes similar things (two stages, two processes, two terms), write cards that hinge on the difference, and put a cue in the question that rules out the neighbour. Two cards whose questions read alike but want different answers will be confused with each other.

Context cue. When a question would be ambiguous outside its subject, prefix it with a short cue drawn from the source title or section heading in the form "Subject: question" (for example "Stages of change: ..."). Omit the cue when the question already names its subject.

Card type. Use qa for definitions, mechanisms, reasons, and distinctions. Use cloze for numbers, dates, names, terms inside a sentence, and enumerations. A cloze sentence is one sentence from the highlight, trimmed to what the deletion needs, with {{c1::...}} markers; each deletion hides a short span (a term, number, or name, not framing words), each independently tested deletion gets a new number, a card carries at most three deletions, and the visible text must be enough to recover the hidden span. Hidden text must appear verbatim in the highlight.

Redundancy. A second card on the same fact is welcome when it tests it from a genuinely different direction (term to definition and definition to term; cause to effect and effect to cause). It is not welcome when the same retrieval would answer both cards.

Write in the language of the highlight unless told otherwise. Keep markdown to **bold** and \`code\`.
</how_to_write>

<examples>
<example>
<highlight>The Dead Sea is a salt lake on the border between Israel and Jordan. Its shoreline is the lowest point on the Earth's surface, about 400 m below sea level. It is roughly seven times as salty as the ocean, which is why swimmers float and only simple organisms survive in it.</highlight>
<cards>
qa | Where is the Dead Sea located? | on the border between Israel and Jordan
qa | What is the lowest point on the Earth's surface? | the Dead Sea shoreline
cloze | The Dead Sea shoreline lies about {{c1::400 m}} below sea level.
cloze | The Dead Sea is roughly {{c1::seven}} times as salty as the ocean.
qa | Why can the Dead Sea keep swimmers afloat? | its high salt content
qa | Why can only simple organisms live in the Dead Sea? | its high salt content
</cards>
<note>One highlight, six atomic cards. The last two share an answer but test different facts, so both stay.</note>
</example>
<example>
<highlight>The general adaptation syndrome unfolds in three stages: alarm, resistance, and exhaustion.</highlight>
<cards>
cloze | The three stages of the general adaptation syndrome are {{c1::alarm}}, resistance, and exhaustion.
cloze | The three stages of the general adaptation syndrome are alarm, {{c1::resistance}}, and exhaustion.
cloze | The three stages of the general adaptation syndrome are alarm, resistance, and {{c1::exhaustion}}.
qa | How many stages does the general adaptation syndrome have? | three
</cards>
<note>An enumeration becomes overlapping cloze cards, each hiding one member, instead of one card asking for the whole list.</note>
</example>
<example>
<highlight>A set is an unordered collection, while an enumeration is ordered. Enumerations are easier to learn than sets because the fixed order gives each item a stable cue.</highlight>
<cards>
qa | Sets vs enumerations: which of the two is ordered? | the enumeration
qa | Why are enumerations easier to learn than sets? | the fixed order gives each item a stable cue
</cards>
<note>Two similar terms: the first card hinges on the difference, the second tests the reason rather than restating the definitions.</note>
</example>
<example>
<highlight>As I mentioned in the previous chapter, this is where things get interesting, and I will come back to it later.</highlight>
<cards>
</cards>
<note>Framing with no fact in it: return no cards.</note>
</example>
</examples>

Before returning, check each card against the highlight: the answer is stated there, the question names its subject, the answer is short, and only one answer fits. Drop any card that fails.`;

/**
 * Critique system prompt: grades the cards already drafted for ONE highlight,
 * all of them in a single call so sibling interference is visible.
 *
 * Adapted from obsidian-loopback's prompts/critique-v1.md, which is cloze-only
 * and assumes a Back Extra field Recall does not have. Carried over from it:
 * the rule that a revision may only use facts the passage states, and the
 * preference for dropping over a fix that stretches past the text. New here:
 * Bloom fit, sibling interference, and near-tautology.
 */
const CRITIC_SYSTEM = `You grade flashcards that have already been drafted from one highlight in a reader's own notes. You do not write new cards. You judge the cards you are given, repair the ones a small fix would save, and drop the ones that should not reach review. Every card that survives costs the reader minutes a year for years, so it should earn that.

Each card is either qa, a question with a short answer, or cloze, one sentence with {{c1::...}} deletions hiding a term, number, or name. There is no back-extra field: whatever the card teaches has to live in the question and its answer, or in the cloze sentence and the framing left visible around the deletion.

<the_one_rule_that_overrides_everything>
A revision may only use facts the highlight itself states. Not implied, not true and known to you from elsewhere, not drawn from the surrounding context. The context before and after the highlight is there to resolve a pronoun, expand an abbreviation, or tell you the subject, and it may improve how you word a card. It never earns the right to become the answer. Rewording a card so it says the same fact more precisely is fine. Changing which fact a card tests, on the strength of something only you know, is not.

A deterministic linter runs after you regardless. It checks every cloze deletion by substring against the highlight and will catch hidden text you invented, so treat this rule as load-bearing rather than a formality.

This is why dropping is the right call more often than reaching for a fix that would stretch past what the passage says. When the repair you have in mind needs one fact the highlight does not carry, the verdict is drop.
</the_one_rule_that_overrides_everything>

<what_to_check>
Judge every card on each of these, then give it one verdict.

Grounding. The answer, and every cloze deletion, is stated in the highlight. A cloze deletion must appear in it word for word.

Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A paragraph answer is a card that has not been split yet. Long answers are the most common defect: if the answer runs past a short phrase and the highlight supports a narrower question, revise; if it does not, drop.

Answerable in isolation. The question names its subject. "What does it weigh?" is a card the reader will meet months from now, shuffled among cards from other notes, with nothing to tell them what it is about.

One correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Yes/no questions, and questions whose wording gives the answer away, fail this.

Bloom fit. Place each card on Bloom's taxonomy: remember, understand, apply, analyze, evaluate, or create. The failure that matters here is a highlight that states a mechanism, a cause, or a reason turned into a card that only asks what something is called. The reader can recite the label and still not know how the thing works. The fix is to ask why or how, not what it is called. Do not push for a level the highlight does not support: when the highlight states a definition and nothing more, "remember" is the correct level and a card that tests it is a good card. Report the level the card actually sits at, including for cards you drop.

Interference. You see every card for this highlight at once, which is the point of grading them together. Two cards whose questions read alike but want different answers will be confused in review, and so will two cards that share an answer. When you find such a pair, say so, and prefer revising one of them to hinge on the cue that tells them apart over dropping both. Two cards may legitimately share an answer when they test genuinely different facts and their questions could not be mistaken for each other.

Near-tautology. An answer that merely restates a word already in the question tests nothing, because the reader reads it back off the prompt. "What does the accountability system make possible?" answered "tracking progress over time" is retrieved from the question, not from memory. Revise so the question withholds the word the answer turns on, or drop.

Cloze form. Only the tested span sits inside a deletion and the framing stays outside. Each deletion is short, deletions are numbered from 1 with no gaps, a card carries at most three, and the visible text is enough to recover what is hidden.

Duplication. If the cards that already exist for this highlight test the same fact, drop the new one. This is advisory, not the authoritative check, so when you are unsure whether it is truly the same fact, keep the card rather than guessing it away.
</what_to_check>

<verdicts>
keep: the card already satisfies the rules above. Echo its kind and leave front, back, and text empty; the original is used unchanged.

revise: a fix stays entirely inside what the highlight already states. Return the whole corrected card: its kind, and for qa the front and back with text empty, or for cloze the text with front and back empty. A revision that needs a fact the highlight does not carry is not a revision, it is a drop.

drop: the card fails on something you cannot fix without adding a fact the highlight does not state, tests nothing worth reviewing, or duplicates a card that already exists. Echo the original kind and leave front, back, and text empty. The card is not deleted; it is flagged for the reader with your reason, and they decide.

Return exactly one verdict for every card you were given, and no verdict for a card you were not given. The index is the number printed beside the card in the list. The reason is one sentence and the reader reads it, so write it to them: say what is wrong with this card, not which rule it broke.
</verdicts>

<examples>
<example>
<highlight>Spaced repetition works because each successful recall makes the memory harder to lose, so the next review can be scheduled further out. The gap between reviews is called the interval.</highlight>
<cards>
0. qa | What is the interval? | the gap between reviews
1. qa | What is spaced repetition? | a technique where each successful recall makes the memory harder to lose, so the next review can be scheduled further out, which is the principle the whole method rests on
2. qa | What makes the memory harder to lose in spaced repetition? | successful recall
3. cloze | Spaced repetition schedules reviews further out because recall {{c1::strengthens the memory trace in the hippocampus}}.
</cards>
<verdicts>
0. keep, remember. The highlight names the term and defines it; a definition sits at remember, and this one is short and exact.
1. revise, understand. The answer is a paragraph, and it tests the same thing card 2 does, so the two would interfere. Revised to "Why can spaced repetition push reviews further apart?" answered "each successful recall makes the memory harder to lose", which is the mechanism the highlight states.
2. keep, understand. Asks what drives the effect rather than what it is called, and the answer is three words taken from the highlight.
3. drop, understand. The hippocampus is nowhere in the highlight. The card tests something that may well be true but the passage never says it, and there is no fix that does not reach past the text.
</verdicts>
<note>One drop, one revise, two keeps. Cards 1 and 2 were close enough to interfere, so the revision pulls card 1 onto the why and leaves card 2 where it was. Card 0 stays at remember because that is all the highlight supports.</note>
</example>
<example>
<highlight>Deliberate practice differs from ordinary repetition in that it targets a weakness just past current ability and requires immediate feedback.</highlight>
<cards>
0. qa | What is deliberate practice a form of? | practice
1. qa | What two things distinguish deliberate practice from ordinary repetition? | it targets a weakness just past current ability, and it requires immediate feedback
</cards>
<verdicts>
0. drop, remember. The answer is already sitting inside the question, so there is nothing here to retrieve.
1. keep, analyze. Two items is a short enough set to ask for at once, both are stated in the highlight, and the question hinges on the distinction the passage is drawing.
</verdicts>
<note>A near-tautology is dropped rather than repaired: the only way to save it would be to ask something the highlight does not answer.</note>
</example>
</examples>

Before you answer, check that every fact in every revision appears in the highlight, that you returned one verdict per card, and that each index matches the number printed beside its card.`;

/**
 * Highlighter system prompt: picks spans of a whole note worth turning into
 * cards. Follows Wozniak's prioritize / build-on-basics rules and the
 * grounding rule that every span must be locatable verbatim in the note.
 * When a lecture transcript accompanies the note it is evidence of emphasis,
 * never a source of quotes.
 */
const HIGHLIGHTER_SYSTEM = `You select spans of a note that are worth remembering, so that each span can be handed to a card writer and turned into flashcards. The reader will review the resulting cards for years, so a span is worth selecting only if forgetting its content would matter.

Return each span as a verbatim quote copied exactly from the note, character for character, including punctuation. The span is located in the note by exact string match, so an ellipsis, a paraphrase, or a trimmed word makes it unusable. Start and end on sentence boundaries where possible.

Each span is one to four sentences and self-contained: it carries a definition, a mechanism, a number, a name, a date, a causal claim, a distinction between similar things, or a memorable formulation, and it can be understood without the surrounding paragraph. Prefer the fundamentals a reader needs before the details, and prefer material with lasting use over trivia. Prefer fewer, denser spans over many thin ones.

Spans must not overlap. Skip frontmatter, navigation, link lists, boilerplate, transitions, and the author's asides.

A transcript, when one is present, is the recording of the lecture that accompanies the note. It tells you what the lecturer treated as important; it is not a source of quotes, so every span is still copied from the note itself. Prefer the passages the lecturer dwells on, repeats, calls important, or says will be tested, and pass over slide content that was skipped or read out without comment. Where the transcript and the note differ in wording, the note's wording is what gets quoted.

The limit you are given is a ceiling, not a target. Over-highlighting fills the reader's inbox with cards they will delete, so returning fewer spans than the limit is the expected outcome, and returning none is right when nothing in the note is supported by the transcript.

Give each span a label of at most six words that names the fact it carries.`;

/**
 * Prompts and schemas live here; the provider chosen in settings does the
 * actual call. The backend is picked per request so switching providers in
 * the settings tab takes effect immediately.
 */
export class LlmClient {
  private anthropic: AnthropicBackend;
  private codex: CodexBackend;

  /**
   * `getHighlights` mirrors the `getSettings` callback rather than importing
   * the store: llm.ts stays free of a dependency on `InboxStore` (and so of
   * `obsidian`, which the store pulls in), and the client keeps holding no
   * state of its own. It defaults to returning nothing so the existing
   * one-argument construction, and the tests, keep working.
   */
  constructor(
    private getSettings: () => RecallSettings,
    private getHighlights: () => Highlight[] = () => [],
  ) {
    this.anthropic = new AnthropicBackend(getSettings);
    this.codex = new CodexBackend(getSettings);
  }

  /**
   * Style examples from the reader's own triage decisions, inbox-wide.
   * Off by default; returns "" when the setting is off or there is no
   * history, so nothing is appended in either case.
   */
  private examplesBlock(): string {
    if (!this.getSettings().historyExamples) return "";
    return buildExamplesBlock(this.getHighlights());
  }

  private backend(): LlmBackend {
    return this.getSettings().provider === "codex" ? this.codex : this.anthropic;
  }

  /** One tiny request, so the settings tab can say whether the provider works. */
  probe(): Promise<{ model: string; via: string }> {
    return this.backend().probe();
  }

  /** Cancel in-flight work on every backend (plugin unload). */
  async abort(): Promise<void> {
    await Promise.all([this.anthropic.abort(), this.codex.abort()]);
  }

  /** "write cards": one highlight (plus context) in, a handful of cards out. */
  async writeCards(h: Highlight, existing: Card[] = []): Promise<CardDraft[]> {
    const s = this.getSettings();
    const parts: string[] = [];
    parts.push(`<source title="${h.sourceTitle}"${h.heading ? ` section="${h.heading}"` : ""}>`);
    if (h.before) parts.push(`<context_before>\n${h.before}\n</context_before>`);
    parts.push(`<highlight>\n${h.text}\n</highlight>`);
    if (h.after) parts.push(`<context_after>\n${h.after}\n</context_after>`);
    parts.push(`</source>`);
    parts.push(`Write at most ${s.maxCardsPerHighlight} cards.`);
    if (s.language) parts.push(`Write the cards in ${s.language}.`);
    if (s.writerInstructions.trim()) parts.push(`Standing instructions: ${s.writerInstructions.trim()}`);
    const writerExamples = this.examplesBlock();
    if (writerExamples) parts.push(writerExamples);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    if (existing.length) {
      parts.push(
        `These cards already exist for this highlight; do not repeat their facts:\n` +
          existing.map((c) => `- ${c.kind === "qa" ? `${c.front} -> ${c.back}` : c.text}`).join("\n"),
      );
    }
    const parsed = await this.backend().complete({
      system: WRITER_SYSTEM,
      user: parts.join("\n\n"),
      schema: CardsOut,
      label: "cards",
      maxTokens: 8000,
    });
    return parsed.cards.filter((c) => (c.kind === "qa" ? c.front.trim() && c.back.trim() : /\{\{c\d+::/.test(c.text)));
  }

  /**
   * "critique": grade every card drafted for one highlight in a single call,
   * so the critic can see interference between siblings. Never mutates
   * `cards`; the caller applies the verdicts. Verdicts whose index does not
   * point at a card are dropped rather than thrown on, since a stray index is
   * a model slip, not a reason to lose the whole highlight.
   */
  async critiqueCards(h: Highlight, cards: Card[], existing: Card[] = []): Promise<CritiqueVerdict[]> {
    if (!cards.length) return [];
    const s = this.getSettings();
    const parts: string[] = [];
    parts.push(`<source title="${h.sourceTitle}"${h.heading ? ` section="${h.heading}"` : ""}>`);
    if (h.before) parts.push(`<context_before>\n${h.before}\n</context_before>`);
    parts.push(`<highlight>\n${h.text}\n</highlight>`);
    if (h.after) parts.push(`<context_after>\n${h.after}\n</context_after>`);
    parts.push(`</source>`);
    parts.push(
      `Cards drafted from this highlight. The leading number is the index to report:\n` +
        cards.map((c, i) => `${i}. ${c.kind === "qa" ? `qa | ${c.front} | ${c.back}` : `cloze | ${c.text}`}`).join("\n"),
    );
    if (s.language) parts.push(`The cards should be written in ${s.language}.`);
    if (s.writerInstructions.trim()) {
      parts.push(`Standing instructions the reader set for their cards; hold these cards to them: ${s.writerInstructions.trim()}`);
    }
    const criticExamples = this.examplesBlock();
    if (criticExamples) parts.push(criticExamples);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    if (existing.length) {
      parts.push(
        `Cards that already exist for this highlight; a new card testing the same fact is a duplicate:\n` +
          existing.map((c) => `- ${c.kind === "qa" ? `${c.front} -> ${c.back}` : c.text}`).join("\n"),
      );
    }
    parts.push(`Return exactly one verdict for each of the ${cards.length} cards above.`);
    const parsed = await this.backend().complete({
      system: CRITIC_SYSTEM,
      user: parts.join("\n\n"),
      schema: VerdictsOut,
      label: "verdicts",
      maxTokens: 8000,
    });
    return parsed.verdicts.filter((v) => Number.isInteger(v.index) && v.index >= 0 && v.index < cards.length);
  }

  /** Rewrite one card according to an instruction ("convert to cloze", "shorter", ...). */
  async rewriteCard(h: Highlight, card: Card, instruction: string): Promise<CardDraft> {
    const s = this.getSettings();
    const current = card.kind === "qa" ? `Q: ${card.front}\nA: ${card.back}` : `Cloze: ${card.text}`;
    const content = [
      `<highlight>\n${h.text}\n</highlight>`,
      `Current card:\n${current}`,
      `Rewrite this one card. Instruction: ${instruction}`,
      s.language ? `Write in ${s.language}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.backend().complete({ system: WRITER_SYSTEM, user: content, schema: CardOut, label: "card", maxTokens: 4000 });
  }

  /** "highlight": pick spans of a whole note worth turning into sections. */
  async highlight(
    noteTitle: string,
    body: string,
    instruction: string,
    transcript: string | null = null,
  ): Promise<Array<{ quote: string; title: string }>> {
    const s = this.getSettings();
    const content = buildHighlighterMessage({
      noteTitle,
      body,
      transcript,
      maxSpans: s.maxAiHighlights,
      standingInstructions: s.highlighterInstructions,
      instruction,
    });
    const parsed = await this.backend().complete({
      system: HIGHLIGHTER_SYSTEM,
      user: content,
      schema: HighlightsOut,
      label: "highlights",
      maxTokens: 16000,
    });
    return parsed.highlights;
  }
}

export function describeError(e: unknown): string {
  if (e instanceof CodexError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API; will retry later.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
