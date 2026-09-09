import { App, FuzzySuggestModal, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import type { TranscriptRecord } from "./model";

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

export type TranscriptChoice =
  | { action: "save"; text: string; origin: "pasted" | "file"; sourceFile: string | null }
  | { action: "clear" };

/** Pick a transcript file from the vault (md, txt, vtt, srt). */
class TranscriptFileSuggestModal extends FuzzySuggestModal<TFile> {
  private resolved = false;

  constructor(
    app: App,
    private resolve: (v: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Transcript file (md, txt, vtt, srt)");
  }

  getItems(): TFile[] {
    const exts = new Set(["md", "txt", "vtt", "srt"]);
    return this.app.vault
      .getFiles()
      .filter((f) => exts.has(f.extension.toLowerCase()))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.resolved = true;
    this.resolve(item);
  }

  onClose(): void {
    super.onClose();
    if (!this.resolved) this.resolve(null);
  }
}

/** Attach, replace, or clear the transcript used for document-wide AI highlighting. */
export class TranscriptModal extends Modal {
  private value: string;
  private origin: "pasted" | "file";
  private sourceFile: string | null;
  private resolved = false;
  private ta!: HTMLTextAreaElement;

  constructor(
    app: App,
    private current: TranscriptRecord | undefined,
    private resolve: (v: TranscriptChoice | null) => void,
  ) {
    super(app);
    this.value = current?.text ?? "";
    this.origin = current?.origin ?? "pasted";
    this.sourceFile = current?.sourceFile ?? null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recall-modal");
    contentEl.createEl("h3", { text: "Transcript for document highlighting" });

    if (this.current) {
      const c = this.current;
      const from = c.origin === "file" ? `from ${c.sourceFile}` : "pasted";
      const cut = c.truncated ? ", cut to the size limit" : "";
      contentEl.createEl("p", {
        text: `Current: ${from}, ${c.text.length.toLocaleString()} characters, added ${c.addedAt}${cut}`,
        cls: "recall-muted",
      });
    } else {
      contentEl.createEl("p", {
        text: "No transcript attached. Paste one below or choose a file.",
        cls: "recall-muted",
      });
    }

    const ta = contentEl.createEl("textarea", {
      attr: { rows: "10", placeholder: "Paste the lecture transcript here…" },
    });
    ta.addClass("recall-modal-textarea");
    ta.value = this.value;
    this.ta = ta;
    ta.addEventListener("input", () => {
      this.value = ta.value;
      this.origin = "pasted";
      this.sourceFile = null;
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Choose a file from the vault…").onClick(() => {
        new TranscriptFileSuggestModal(this.app, async (file) => {
          if (!file) return;
          const text = await this.app.vault.cachedRead(file);
          this.value = text;
          this.origin = "file";
          this.sourceFile = file.path;
          this.ta.value = text;
        }).open();
      }),
    );

    const buttons = new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    if (this.current) {
      buttons.addButton((b) =>
        b.setButtonText("Clear").onClick(() => {
          this.resolved = true;
          this.resolve({ action: "clear" });
          this.close();
        }),
      );
    }
    buttons.addButton((b) =>
      b
        .setCta()
        .setButtonText("Save")
        .onClick(() => this.submit()),
    );

    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    const text = this.value.trim();
    if (!text) {
      new Notice("Recall: paste a transcript or choose a file first.");
      return;
    }
    this.resolved = true;
    this.resolve({ action: "save", text, origin: this.origin, sourceFile: this.sourceFile });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askTranscript(app: App, current: TranscriptRecord | undefined): Promise<TranscriptChoice | null> {
  return new Promise((resolve) => new TranscriptModal(app, current, resolve).open());
}
