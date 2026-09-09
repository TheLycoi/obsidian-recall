import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicBackend } from "./anthropic";
import type { LlmBackend } from "./backend";
import { CodexBackend, CodexError } from "./codex";
import type { Card, Highlight } from "./model";
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
 * Highlighter system prompt: picks spans of a whole note worth turning into
 * cards. Follows Wozniak's prioritize / build-on-basics rules and the
 * grounding rule that every span must be locatable verbatim in the note.
 */
const HIGHLIGHTER_SYSTEM = `You select spans of a note that are worth remembering, so that each span can be handed to a card writer and turned into flashcards. The reader will review the resulting cards for years, so a span is worth selecting only if forgetting its content would matter.

Return each span as a verbatim quote copied exactly from the note, character for character, including punctuation. The span is located in the note by exact string match, so an ellipsis, a paraphrase, or a trimmed word makes it unusable. Start and end on sentence boundaries where possible.

Each span is one to four sentences and self-contained: it carries a definition, a mechanism, a number, a name, a date, a causal claim, a distinction between similar things, or a memorable formulation, and it can be understood without the surrounding paragraph. Prefer the fundamentals a reader needs before the details, and prefer material with lasting use over trivia. Prefer fewer, denser spans over many thin ones.

Spans must not overlap. Skip frontmatter, navigation, link lists, boilerplate, transitions, and the author's asides.

Give each span a label of at most six words that names the fact it carries.`;

/**
 * Prompts and schemas live here; the provider chosen in settings does the
 * actual call. The backend is picked per request so switching providers in
 * the settings tab takes effect immediately.
 */
export class LlmClient {
  private anthropic: AnthropicBackend;
  private codex: CodexBackend;

  constructor(private getSettings: () => RecallSettings) {
    this.anthropic = new AnthropicBackend(getSettings);
    this.codex = new CodexBackend(getSettings);
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
  async highlight(noteTitle: string, body: string, instruction: string): Promise<Array<{ quote: string; title: string }>> {
    const s = this.getSettings();
    const content = [
      `<note title="${noteTitle}">\n${body}\n</note>`,
      `Select at most ${s.maxAiHighlights} spans.`,
      s.highlighterInstructions.trim() ? `Standing instructions: ${s.highlighterInstructions.trim()}` : "",
      instruction.trim() ? `Instructions for this note: ${instruction.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
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
