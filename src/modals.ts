import { App, Modal, Setting, SuggestModal } from "obsidian";

/** Ask for a free-text instruction. Resolves null when cancelled. */
export class InstructionModal extends Modal {
  private value = "";
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recall-modal");
    contentEl.createEl("h3", { text: this.title });
    const ta = contentEl.createEl("textarea", { attr: { rows: "4", placeholder: this.placeholder } });
    ta.addClass("recall-modal-textarea");
    ta.addEventListener("input", () => (this.value = ta.value));
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Send")
          .onClick(() => this.submit()),
      );
    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    this.resolved = true;
    this.resolve(this.value.trim());
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askInstruction(app: App, title: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => new InstructionModal(app, title, placeholder, resolve).open());
}

/** Pick an Anki deck; typing a new name creates it on export. */
export class DeckSuggestModal extends SuggestModal<string> {
  private resolved = false;

  constructor(
    app: App,
    private decks: string[],
    private resolve: (v: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Deck name (type a new one to create it)");
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    const hits = this.decks.filter((d) => d.toLowerCase().includes(q));
    if (query && !this.decks.includes(query)) hits.unshift(query);
    return hits;
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
    if (!this.decks.includes(value)) el.createSpan({ text: "  (new deck)", cls: "recall-muted" });
  }

  onChooseSuggestion(item: string): void {
    this.resolved = true;
    this.resolve(item);
  }

  onClose(): void {
    super.onClose();
    if (!this.resolved) this.resolve(null);
  }
}

export function pickDeck(app: App, decks: string[]): Promise<string | null> {
  return new Promise((resolve) => new DeckSuggestModal(app, decks, resolve).open());
}
