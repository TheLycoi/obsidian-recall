import { newId } from "./util";

export type HighlightStatus = "queued" | "generating" | "ready" | "exported" | "error" | "dismissed";
export type CardStatus = "pending" | "exported" | "duplicate" | "deleted";
export type CardKind = "qa" | "cloze";

export interface Card {
  id: string;
  highlightId: string;
  kind: CardKind;
  /** Q&A front (question). Empty for cloze. */
  front: string;
  /** Q&A back (answer). Empty for cloze. */
  back: string;
  /** Cloze text with {{c1::...}} markers. Empty for Q&A. */
  text: string;
  extra: string;
  status: CardStatus;
  edited: boolean;
  ankiNoteId?: number;
  createdAt: string;
}

export interface Highlight {
  id: string;
  sourcePath: string;
  sourceTitle: string;
  /** Verbatim highlighted text. */
  text: string;
  before: string;
  after: string;
  line: number;
  /** 1-indexed PDF page when the source is a PDF; null for markdown notes. */
  page: number | null;
  heading: string | null;
  blockId: string | null;
  /** Short AI or user-supplied label, e.g. "Catholic Church definition". */
  title: string;
  /** Per-highlight user instruction passed to the card writer. */
  instruction: string;
  status: HighlightStatus;
  error: string | null;
  createdAt: string;
  generatedAt: string | null;
  exportedAt: string | null;
  cards: Card[];
  origin: "selection" | "markdown-highlight" | "ai" | "highlighter" | "pdf";
}

export interface InboxData {
  version: 1;
  highlights: Highlight[];
}

export function makeHighlight(
  init: Partial<Highlight> & Pick<Highlight, "sourcePath" | "sourceTitle" | "text">,
): Highlight {
  return {
    id: newId("h"),
    before: "",
    after: "",
    line: 0,
    page: null,
    heading: null,
    blockId: null,
    title: "",
    instruction: "",
    status: "queued",
    error: null,
    createdAt: new Date().toISOString(),
    generatedAt: null,
    exportedAt: null,
    cards: [],
    origin: "selection",
    ...init,
  };
}

export function makeCard(highlightId: string, init: Partial<Card> & { kind: CardKind }): Card {
  return {
    id: newId("c"),
    highlightId,
    front: "",
    back: "",
    text: "",
    extra: "",
    status: "pending",
    edited: false,
    createdAt: new Date().toISOString(),
    ...init,
  };
}

export function isPdfHighlight(h: Highlight): boolean {
  return h.page !== null || /\.pdf$/i.test(h.sourcePath);
}

export function liveCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status !== "deleted");
}

export function pendingCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status === "pending");
}
