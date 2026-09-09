import { ItemView, MarkdownView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type RecallPlugin from "./main";
import { RECALL_ICON } from "./icon";
import { isPdfHighlight, liveCards, makeCard, pendingCards, type Card, type Highlight } from "./model";
import { askInstruction } from "./modals";
import { countClozes, fmtDate, ungroundedClozes } from "./util";
import { describeError } from "./llm";

export const VIEW_TYPE_INBOX = "recall-inbox";

type Filter = "review" | "all" | "exported";

/**
 * The inbox: every highlight grouped under its source note, cards packed
 * densely beside the highlight they came from, built for fast triage.
 */
export class InboxView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private filter: Filter = "review";
  private collapsed = new Set<string>();
  private editing: string | null = null;
  private focusedCard: string | null = null;
  private renderScheduled = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: RecallPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_INBOX;
  }
  getDisplayText(): string {
    return "Recall inbox";
  }
  getIcon(): string {
    return RECALL_ICON;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("recall-inbox");
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKey(e));
    this.unsubscribe = this.plugin.store.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  private scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  // ---------------------------------------------------------------- data

  private visibleHighlights(): Highlight[] {
    return this.plugin.store.all().filter((h) => {
      if (h.status === "dismissed") return this.filter === "all";
      if (this.filter === "review") return h.status !== "exported";
      if (this.filter === "exported") return h.status === "exported";
      return true;
    });
  }

  private groupBySource(hs: Highlight[]): Map<string, Highlight[]> {
    const m = new Map<string, Highlight[]>();
    for (const h of hs) {
      const arr = m.get(h.sourcePath) ?? [];
      arr.push(h);
      m.set(h.sourcePath, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.line - b.line);
    return m;
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    root.empty();

    this.renderHeader(root);

    const hs = this.visibleHighlights();
    if (hs.length === 0) {
      const empty = root.createDiv({ cls: "recall-empty" });
      empty.createEl("p", { text: this.filter === "review" ? "Nothing to review." : "Nothing here." });
      empty.createEl("p", {
                cls: "recall-muted",
        text: "Turn on highlighter mode (ribbon pen) and drag across a passage in a note or PDF, or select text and run “Recall: Send selection to inbox”. Cards are written in the background and show up here.",
      });
      return;
    }

    const groups = this.groupBySource(hs);
    for (const [path, list] of groups) this.renderSource(root, path, list);

    root.scrollTop = scrollTop;
  }

  private renderHeader(root: HTMLElement): void {
    const counts = this.plugin.store.counts();
    const header = root.createDiv({ cls: "recall-header" });
    const left = header.createDiv({ cls: "recall-header-left" });
    left.createEl("h2", { text: "Inbox" });
    const stats = left.createDiv({ cls: "recall-stats" });
    const stat = (label: string, n: number, cls = "") => {
      const s = stats.createSpan({ cls: `recall-stat ${cls}` });
      s.createSpan({ cls: "recall-stat-n", text: String(n) });
      s.createSpan({ text: ` ${label}` });
    };
    stat("to review", counts.toReview);
    if (counts.queued + counts.generating) stat("writing", counts.queued + counts.generating, "is-busy");
    if (counts.errors) stat("failed", counts.errors, "is-error");

    const right = header.createDiv({ cls: "recall-header-right" });

    const filter = right.createEl("select", { cls: "dropdown recall-filter" });
    for (const [v, label] of [
      ["review", "To review"],
      ["exported", "Exported"],
      ["all", "Everything"],
    ] as const) {
      const o = filter.createEl("option", { text: label, value: v });
      if (v === this.filter) o.selected = true;
    }
    filter.addEventListener("change", () => {
      this.filter = filter.value as Filter;
      this.render();
    });

    const deckBtn = right.createEl("button", { cls: "recall-deck-btn" });
    setIcon(deckBtn.createSpan(), "layers");
    deckBtn.createSpan({ text: this.plugin.settings.defaultDeck });
    deckBtn.title = "Change the target deck";
    deckBtn.addEventListener("click", async () => {
      const d = await this.plugin.chooseDeck();
      if (d) {
        this.plugin.settings.defaultDeck = d;
        await this.plugin.saveSettings();
        this.render();
      }
    });

    const exportAll = right.createEl("button", { cls: "mod-cta", text: "Export all reviewed" });
    exportAll.title = "Send every pending card in the inbox to Anki (⌘⏎)";
    exportAll.addEventListener("click", () => void this.exportHighlights(this.visibleHighlights()));

    const more = right.createEl("button", { cls: "clickable-icon recall-icon-btn" });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Retry failed highlights")
          .setIcon("refresh-cw")
          .onClick(() => {
            for (const h of this.plugin.store.all()) if (h.status === "error") this.plugin.generator.enqueue(h);
          }),
      );
      menu.addItem((i) =>
        i
          .setTitle("Export reviewed as Anki text file")
          .setIcon("file-down")
          .onClick(() => void this.plugin.exportAsTextFile(this.visibleHighlights())),
      );
      menu.addItem((i) =>
        i
          .setTitle("Clear exported and dismissed")
          .setIcon("trash")
          .onClick(() => {
            const n = this.plugin.store.clearExported();
            new Notice(`Recall: cleared ${n}.`);
          }),
      );
      menu.addItem((i) =>
        i
          .setTitle("Keyboard: j/k move · e edit · x delete · Enter export highlight")
          .setDisabled(true),
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private renderSource(root: HTMLElement, path: string, list: Highlight[]): void {
    const section = root.createDiv({ cls: "recall-source" });
    const head = section.createDiv({ cls: "recall-source-head" });
    const toggle = head.createSpan({ cls: "recall-collapse" });
    setIcon(toggle, this.collapsed.has(path) ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", () => {
      if (this.collapsed.has(path)) this.collapsed.delete(path);
      else this.collapsed.add(path);
      this.render();
    });
    const title = head.createEl("a", { cls: "recall-source-title", text: list[0].sourceTitle });
    title.addEventListener("click", () => void this.plugin.app.workspace.openLinkText(path, "", "tab"));
    const pending = list.reduce((n, h) => n + pendingCards(h).length, 0);
    head.createSpan({
      cls: "recall-muted",
      text: `${list.length} highlight${list.length === 1 ? "" : "s"} · ${pending} card${pending === 1 ? "" : "s"} to review`,
    });
    const actions = head.createDiv({ cls: "recall-source-actions" });
    if (pending) {
      const b = actions.createEl("button", { text: "Export note" });
      b.title = "Send all reviewed cards from this note to Anki";
      b.addEventListener("click", () => void this.exportHighlights(list));
    }
    if (this.collapsed.has(path)) return;

    for (const h of list) this.renderHighlight(section, h);
  }

  private renderHighlight(section: HTMLElement, h: Highlight): void {
    const row = section.createDiv({ cls: `recall-hl recall-hl-${h.status}` });
    row.dataset.id = h.id;

    // Left column: the highlight itself.
    const left = row.createDiv({ cls: "recall-hl-left" });
    const meta = left.createDiv({ cls: "recall-hl-meta" });
    const titleEl = meta.createSpan({ cls: "recall-hl-title", text: h.title || h.heading || "Highlight" });
    titleEl.title = "Click to rename";
    titleEl.addEventListener("click", () => {
      const input = createEl("input", { type: "text", value: h.title });
      input.addClass("recall-inline-input");
      titleEl.replaceWith(input);
      input.focus();
      const commit = () => {
        h.title = input.value.trim();
        this.plugin.store.touch();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") this.render();
      });
    });
    const badge = meta.createSpan({ cls: `recall-badge recall-badge-${h.status}` });
    badge.setText(
      h.status === "queued"
        ? "queued"
        : h.status === "generating"
          ? "writing…"
          : h.status === "error"
            ? "failed"
            : h.status === "exported"
              ? "exported"
              : h.status === "dismissed"
                ? "dismissed"
                : `${pendingCards(h).length} to review`,
    );

    const quote = left.createDiv({ cls: "recall-quote" });
    quote.setText(h.text);
    quote.title = "Open in the note";
    quote.addEventListener("click", () => void this.openSource(h));

    const where = left.createDiv({ cls: "recall-hl-where recall-muted" });
    where.setText(
      [
        isPdfHighlight(h) ? "PDF" : h.heading ? `§ ${h.heading}` : null,
        h.page ? `page ${h.page}` : `line ${h.line + 1}`,
        h.origin === "highlighter" ? "highlighter" : h.origin === "ai" ? "AI pick" : null,
        fmtDate(h.createdAt),
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (h.instruction) left.createDiv({ cls: "recall-hl-instruction", text: `“${h.instruction}”` });
    if (h.status === "error" && h.error) left.createDiv({ cls: "recall-error", text: h.error });

    const hlActions = left.createDiv({ cls: "recall-hl-actions" });
    const iconBtn = (icon: string, tip: string, fn: () => void) => {
      const b = hlActions.createEl("button", { cls: "clickable-icon recall-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.addEventListener("click", fn);
      return b;
    };
    if (h.status === "ready" && pendingCards(h).length) {
      iconBtn("send", "Export this highlight's cards to Anki (Enter)", () => void this.exportHighlights([h]));
    }
    if (h.status === "error") iconBtn("refresh-cw", "Retry", () => this.plugin.generator.enqueue(h));
    if (h.status === "ready" || h.status === "exported") {
      iconBtn("sparkles", "Write more cards for this highlight", async () => {
        const inst = await askInstruction(this.plugin.app, "More cards", "Optional: what should the extra cards cover?");
        if (inst === null) return;
        if (inst) h.instruction = inst;
        this.plugin.generator.more(h);
      });
    }
    iconBtn("plus", "Add a card by hand", () => {
      const c = makeCard(h.id, { kind: "qa", front: "", back: "" });
      h.cards.push(c);
      if (h.status === "exported") h.status = "ready";
      this.editing = c.id;
      this.plugin.store.touch();
    });
    if (h.status !== "dismissed") {
      iconBtn("x", "Dismiss highlight and its cards", () => {
        h.status = "dismissed";
        this.plugin.store.touch();
      });
    } else {
      iconBtn("trash-2", "Delete permanently", () => this.plugin.store.remove(h.id));
    }

    // Right column: the cards.
    const right = row.createDiv({ cls: "recall-cards" });
    const cards = liveCards(h);
    if (h.status === "queued" || h.status === "generating") {
      right.createDiv({ cls: "recall-muted recall-cards-empty", text: "Cards are being written in the background…" });
    } else if (cards.length === 0) {
      right.createDiv({ cls: "recall-muted recall-cards-empty", text: "No cards." });
    }
    for (const c of cards) this.renderCard(right, h, c);
  }

  private renderCard(parent: HTMLElement, h: Highlight, c: Card): void {
    const el = parent.createDiv({ cls: `recall-card recall-card-${c.kind} recall-card-${c.status}` });
    el.dataset.id = c.id;
    if (this.focusedCard === c.id) el.addClass("is-focused");
    el.addEventListener("click", () => {
      this.focusedCard = c.id;
      this.contentEl.querySelectorAll(".recall-card.is-focused").forEach((x) => x.removeClass("is-focused"));
      el.addClass("is-focused");
    });

    const top = el.createDiv({ cls: "recall-card-top" });
    top.createSpan({ cls: "recall-kind", text: c.kind === "qa" ? "Question" : `Cloze${countClozes(c.text) > 1 ? ` ×${countClozes(c.text)}` : ""}` });
    if (c.status === "exported") top.createSpan({ cls: "recall-badge recall-badge-exported", text: "in Anki" });
    if (c.status === "duplicate") top.createSpan({ cls: "recall-badge recall-badge-duplicate", text: "duplicate" });
    if (c.edited && c.status === "pending") top.createSpan({ cls: "recall-badge", text: "edited" });
    if (c.kind === "cloze" && c.status === "pending") {
      const missing = ungroundedClozes(c.text, `${h.text}`);
      if (missing.length) {
        const b = top.createSpan({ cls: "recall-badge recall-badge-warn", text: "not in highlight" });
        b.title = `These deletions do not appear in the highlight verbatim: ${missing.join(" · ")}`;
      }
    }
    const actions = top.createDiv({ cls: "recall-card-actions" });
    const btn = (icon: string, tip: string, fn: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon recall-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
    };
    if (c.status === "pending") {
      btn("pencil", "Edit (e)", () => {
        this.editing = this.editing === c.id ? null : c.id;
        this.render();
      });
      btn("sparkles", "Rewrite with an instruction", () => void this.rewrite(h, c));
      btn(c.kind === "qa" ? "brackets" : "help-circle", c.kind === "qa" ? "Convert to cloze" : "Convert to Q&A", () =>
        void this.rewrite(h, c, c.kind === "qa" ? "Convert this Q&A card into a cloze card." : "Convert this cloze card into a question and answer card."),
      );
      btn("trash-2", "Delete (x)", () => this.deleteCard(h, c));
    } else if (c.status === "duplicate") {
      btn("trash-2", "Remove", () => this.deleteCard(h, c));
    }

    if (this.editing === c.id) {
      this.renderEditor(el, h, c);
      return;
    }

    const body = el.createDiv({ cls: "recall-card-body" });
    if (c.kind === "qa") {
      body.createDiv({ cls: "recall-field-label", text: "Question" });
      body.createDiv({ cls: "recall-field", text: c.front });
      body.createDiv({ cls: "recall-field-label", text: "Answer" });
      body.createDiv({ cls: "recall-field", text: c.back });
    } else {
      const f = body.createDiv({ cls: "recall-field recall-cloze" });
      this.renderClozeText(f, c.text);
    }
  }

  private renderClozeText(el: HTMLElement, text: string): void {
    const re = /\{\{(c\d+)::([\s\S]*?)(?:::([^}]*))?\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendText(text.slice(last, m.index));
      const chip = el.createSpan({ cls: "recall-cloze-chip" });
      chip.createSpan({ cls: "recall-cloze-n", text: m[1].slice(1) });
      chip.appendText(m[2]);
      chip.title = m[3] ? `hint: ${m[3]}` : m[1];
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendText(text.slice(last));
  }

  private renderEditor(el: HTMLElement, h: Highlight, c: Card): void {
    const form = el.createDiv({ cls: "recall-editor" });
    const kindSel = form.createEl("select", { cls: "dropdown" });
    kindSel.createEl("option", { value: "qa", text: "Question / answer" });
    kindSel.createEl("option", { value: "cloze", text: "Cloze" });
    kindSel.value = c.kind;

    const front = form.createEl("textarea", { attr: { rows: "2", placeholder: "Question" } });
    front.value = c.front;
    const back = form.createEl("textarea", { attr: { rows: "2", placeholder: "Answer" } });
    back.value = c.back;
    const text = form.createEl("textarea", { attr: { rows: "3", placeholder: "Sentence with {{c1::deletions}}" } });
    text.value = c.text;
    const extra = form.createEl("textarea", { attr: { rows: "1", placeholder: "Extra (optional, shown on the back)" } });
    extra.value = c.extra;

    const sync = () => {
      const isQa = kindSel.value === "qa";
      front.toggle(isQa);
      back.toggle(isQa);
      text.toggle(!isQa);
    };
    kindSel.addEventListener("change", sync);
    sync();

    const save = () => {
      const before = JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]);
      c.kind = kindSel.value as Card["kind"];
      c.front = front.value.trim();
      c.back = back.value.trim();
      c.text = text.value.trim();
      c.extra = extra.value.trim();
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) {
        new Notice("Recall: empty card discarded.");
        c.status = "deleted";
      } else if (JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]) !== before) {
        c.edited = true;
      }
      this.editing = null;
      this.plugin.store.touch();
    };
    const cancel = () => {
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) c.status = "deleted";
      this.editing = null;
      this.plugin.store.touch();
    };
    for (const ta of [front, back, text, extra]) {
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
    }
    const btns = form.createDiv({ cls: "recall-editor-btns" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
    btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", save);
    btns.createSpan({ cls: "recall-muted", text: "⌘⏎ save · esc cancel" });
    window.setTimeout(() => (c.kind === "qa" ? front : text).focus(), 10);
  }

  // ---------------------------------------------------------------- actions

  private deleteCard(h: Highlight, c: Card): void {
    c.status = "deleted";
    if (this.focusedCard === c.id) this.focusedCard = this.neighbourCardId(c.id);
    this.plugin.store.touch();
  }

  private async rewrite(h: Highlight, c: Card, preset?: string): Promise<void> {
    const instruction = preset ?? (await askInstruction(this.plugin.app, "Rewrite card", "e.g. make the answer shorter, ask about the date instead"));
    if (!instruction) return;
    const notice = new Notice("Recall: rewriting…", 0);
    try {
      const d = await this.plugin.llm.rewriteCard(h, c, instruction);
      c.kind = d.kind;
      c.front = d.kind === "qa" ? d.front.trim() : "";
      c.back = d.kind === "qa" ? d.back.trim() : "";
      c.text = d.kind === "cloze" ? d.text.trim() : "";
      c.edited = true;
      this.plugin.store.touch();
    } catch (e) {
      new Notice(`Recall: ${describeError(e)}`);
    } finally {
      notice.hide();
    }
  }

  private async exportHighlights(list: Highlight[]): Promise<void> {
    await this.plugin.exportHighlights(list);
  }

  private async openSource(h: Highlight): Promise<void> {
    if (h.page) {
      await this.plugin.app.workspace.openLinkText(`${h.sourcePath}#page=${h.page}`, "", "tab");
      return;
    }
    const target = h.blockId ? `${h.sourcePath}#^${h.blockId}` : h.sourcePath;
    await this.plugin.app.workspace.openLinkText(target, "", "tab");
    if (h.blockId) return;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file?.path === h.sourcePath) {
      const line = Math.min(h.line, view.editor.lineCount() - 1);
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
  }

  // ---------------------------------------------------------------- keys

  private cardIds(): string[] {
    return Array.from(this.contentEl.querySelectorAll<HTMLElement>(".recall-card")).map((e) => e.dataset.id!).filter(Boolean);
  }

  private neighbourCardId(id: string): string | null {
    const ids = this.cardIds();
    const i = ids.indexOf(id);
    if (i === -1) return ids[0] ?? null;
    return ids[i + 1] ?? ids[i - 1] ?? null;
  }

  private focusCard(id: string | null): void {
    this.focusedCard = id;
    this.contentEl.querySelectorAll(".recall-card.is-focused").forEach((x) => x.removeClass("is-focused"));
    if (!id) return;
    const el = this.contentEl.querySelector<HTMLElement>(`.recall-card[data-id="${id}"]`);
    if (el) {
      el.addClass("is-focused");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    const ids = this.cardIds();
    const i = this.focusedCard ? ids.indexOf(this.focusedCard) : -1;
    const found = this.focusedCard ? this.plugin.store.findCard(this.focusedCard) : undefined;

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void this.exportHighlights(this.visibleHighlights());
      return;
    }
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        this.focusCard(ids[Math.min(ids.length - 1, i + 1)] ?? null);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        this.focusCard(ids[Math.max(0, i - 1)] ?? null);
        break;
      case "x":
      case "Delete":
      case "Backspace":
        if (found && found.card.status === "pending") {
          e.preventDefault();
          this.deleteCard(found.highlight, found.card);
        }
        break;
      case "e":
        if (found && found.card.status === "pending") {
          e.preventDefault();
          this.editing = found.card.id;
          this.render();
        }
        break;
      case "Enter":
        if (found) {
          e.preventDefault();
          void this.exportHighlights([found.highlight]);
        }
        break;
      case "o":
        if (found) {
          e.preventDefault();
          void this.openSource(found.highlight);
        }
        break;
    }
  }
}
