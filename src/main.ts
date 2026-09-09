import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { RECALL_ICON, registerRecallIcon } from "./icon";
import { AnkiClient, exportToAnki, finalizeHighlights, buildNote } from "./anki";
import { aiHighlightNote, captureMarkdownHighlights, capturePdfSelection, captureReadingSelection, captureSelection } from "./capture";
import { Generator } from "./generator";
import { Highlighter } from "./highlighter";
import { isPdfFile, readPdfSelection } from "./pdf";
import { InboxView, VIEW_TYPE_INBOX } from "./inboxView";
import { LlmClient } from "./llm";
import { askInstruction, askTranscript, pickDeck } from "./modals";
import type { Card, Highlight } from "./model";
import { DEFAULT_SETTINGS, RecallSettingTab, type RecallSettings } from "./settings";
import { InboxStore } from "./store";
import { buildAnkiTextImport, normalizeTranscript, truncateTranscript } from "./util";

export default class RecallPlugin extends Plugin {
  settings: RecallSettings = { ...DEFAULT_SETTINGS };
  store!: InboxStore;
  generator!: Generator;
  llm!: LlmClient;
  anki!: AnkiClient;
  highlighter!: Highlighter;
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    registerRecallIcon();
    this.store = new InboxStore(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/recall`);
    await this.store.load();
    this.llm = new LlmClient(() => this.settings);
    this.anki = new AnkiClient(() => this.settings.ankiConnectUrl);
    this.generator = new Generator(this);

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new InboxView(leaf, this));
    this.addSettingTab(new RecallSettingTab(this.app, this));

    this.addRibbonIcon(RECALL_ICON, "Recall inbox", () => void this.openInbox());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("recall-statusbar");
    this.statusBar.addEventListener("click", () => void this.openInbox());
    this.store.onChange(() => this.refreshStatusBar());
    this.highlighter = new Highlighter(this);
    this.highlighter.install();
    this.refreshStatusBar();

    // ---- commands -------------------------------------------------------
    this.addCommand({
      id: "capture-selection",
      name: "Send selection to inbox",
      checkCallback: (checking) => {
        const view = this.activeMarkdown();
        if (!view?.file) return false;
        if (!checking) {
          if (view.getMode() === "preview") void captureReadingSelection(this, view, activeWindow);
          else void captureSelection(this, view.editor, view.file);
        }
        return true;
      },
    });
    this.addCommand({
      id: "capture-pdf-selection",
      name: "Send PDF selection to inbox",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdfFile(file)) return false;
        if (!checking) {
          const sel = readPdfSelection(activeWindow);
          if (!sel) new Notice("Recall: select text inside a PDF page first.");
          else capturePdfSelection(this, file, sel);
        }
        return true;
      },
    });
    this.addCommand({
      id: "capture-pdf-selection-with-instruction",
      name: "Send PDF selection to inbox with instructions…",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdfFile(file)) return false;
        if (!checking) {
          const sel = readPdfSelection(activeWindow);
          if (!sel) {
            new Notice("Recall: select text inside a PDF page first.");
            return true;
          }
          void askInstruction(this.app, "Instructions for this highlight", "e.g. one cloze on the number").then((inst) => {
            if (inst !== null) capturePdfSelection(this, file, sel, { instruction: inst });
          });
        }
        return true;
      },
    });
    this.addCommand({
      id: "capture-selection-with-instruction",
      name: "Send selection to inbox with instructions…",
      editorCallback: async (editor, ctx) => {
        if (!ctx.file) return;
        const inst = await askInstruction(this.app, "Instructions for this highlight", "e.g. one cloze on the number; cards in Dutch; focus on the mechanism");
        if (inst === null) return;
        await captureSelection(this, editor, ctx.file, inst);
      },
    });
    this.addCommand({
      id: "capture-markdown-highlights",
      name: "Send all ==highlights== in this note to inbox",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void captureMarkdownHighlights(this, file);
        return true;
      },
    });
    this.addCommand({
      id: "ai-highlight",
      name: "AI-highlight this note and write cards",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) aiHighlightNote(this, file);
        return true;
      },
    });
    this.addCommand({
      id: "ai-highlight-with-instruction",
      name: "AI-highlight this note with instructions…",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) {
          void askInstruction(this.app, "What should the highlighter look for?", "e.g. only the definitions and the numbers in the Results section").then((inst) => {
            if (inst !== null) aiHighlightNote(this, file, inst);
          });
        }
        return true;
      },
    });
    this.addCommand({
      id: "add-transcript",
      name: "Add transcript for document highlighting",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) {
          void askTranscript(this.app, this.store.getTranscript(file.path)).then((choice) => {
            if (choice === null) return;
            if (choice.action === "clear") {
              this.store.clearTranscript(file.path);
              new Notice("Recall: transcript removed.");
              return;
            }
            const cleaned = normalizeTranscript(choice.text);
            const { text: kept, truncated } = truncateTranscript(cleaned, this.settings.transcriptMaxChars);
            this.store.setTranscript(file.path, {
              text: kept,
              origin: choice.origin,
              sourceFile: choice.sourceFile,
              addedAt: new Date().toISOString(),
              truncated,
            });
            new Notice(`Recall: transcript saved (${kept.length.toLocaleString()} characters)${truncated ? ", cut to the size limit" : ""}.`);
          });
        }
        return true;
      },
    });
    this.addCommand({ id: "open-inbox", name: "Open inbox", callback: () => void this.openInbox() });
    this.addCommand({
      id: "export-reviewed",
      name: "Export all reviewed cards to Anki",
      callback: () => void this.exportHighlights(this.store.all().filter((h) => h.status === "ready")),
    });
    this.addCommand({
      id: "retry-failed",
      name: "Retry failed highlights",
      callback: () => {
        let n = 0;
        for (const h of this.store.all()) if (h.status === "error") (this.generator.enqueue(h), n++);
        new Notice(`Recall: retrying ${n}.`);
      },
    });

    // ---- editor context menu --------------------------------------------
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!file) return;
        menu.addItem((item) =>
          item
            .setTitle(editor.getSelection().trim() ? "Recall: send selection to inbox" : "Recall: send paragraph to inbox")
            .setIcon(RECALL_ICON)
            .setSection("recall")
            .onClick(() => void captureSelection(this, editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Recall: send with instructions…")
            .setIcon("message-square")
            .setSection("recall")
            .onClick(async () => {
              const inst = await askInstruction(this.app, "Instructions for this highlight", "e.g. one cloze on the number");
              if (inst !== null) await captureSelection(this, editor, file, inst);
            }),
        );
      }),
    );

    this.app.workspace.onLayoutReady(() => this.generator.start());
  }

  async onunload(): Promise<void> {
    this.generator.stop();
    await this.llm.abort();
    await this.store.flush();
  }

  // ---------------------------------------------------------------- helpers

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<RecallSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshStatusBar();
  }

  refreshStatusBar(): void {
    if (!this.statusBar) return;
    const c = this.store.counts();
    const parts: string[] = [];
    if (this.highlighter?.enabled) parts.push("🖊 highlighter");
    if (c.queued + c.generating) parts.push(`✎ ${c.queued + c.generating}`);
    if (c.toReview) parts.push(`⧉ ${c.toReview}`);
    if (c.errors) parts.push(`⚠ ${c.errors}`);
    this.statusBar.setText(parts.length ? `Recall ${parts.join(" · ")}` : "Recall");
    this.statusBar.toggleClass("recall-statusbar-highlighter", !!this.highlighter?.enabled);
    this.statusBar.title = `Recall: ${this.highlighter?.enabled ? "highlighter mode on, " : ""}${c.queued + c.generating} writing, ${c.toReview} cards to review${c.errors ? `, ${c.errors} failed` : ""}. Click to open the inbox.`;
  }

  async openInbox(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing[0]) await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async chooseDeck(): Promise<string | null> {
    let decks: string[] = [];
    try {
      decks = await this.anki.deckNames();
    } catch {
      new Notice("Recall: Anki not reachable; type a deck name.");
    }
    return pickDeck(this.app, decks);
  }

  /** Fill note-type settings from what Anki actually has. */
  async detectNoteTypes(): Promise<void> {
    const models = await this.anki.modelNames();
    const pick = (cands: string[]) => cands.find((c) => models.includes(c));
    const basic = pick(["Janus - Basic (v2)", "Basic+", "Basic"]) ?? models.find((m) => /basic/i.test(m));
    const cloze = pick(["Janus - Cloze (v2)", "Cloze+", "Cloze"]) ?? models.find((m) => /cloze/i.test(m));
    if (basic) {
      const f = await this.anki.modelFieldNames(basic);
      this.settings.basicModel = basic;
      this.settings.basicFrontField = f.find((x) => /front|question/i.test(x)) ?? f[0];
      this.settings.basicBackField = f.find((x) => /back|answer/i.test(x)) ?? f[1] ?? f[0];
      this.settings.basicExtraField = f.find((x) => /extra|source|notes/i.test(x)) ?? "";
    }
    if (cloze) {
      const f = await this.anki.modelFieldNames(cloze);
      this.settings.clozeModel = cloze;
      this.settings.clozeTextField = f.find((x) => /text/i.test(x)) ?? f[0];
      this.settings.clozeExtraField = f.find((x) => /extra|source|notes/i.test(x)) ?? "";
    }
    await this.saveSettings();
  }

  private pendingItems(list: Highlight[]): Array<{ card: Card; highlight: Highlight }> {
    const items: Array<{ card: Card; highlight: Highlight }> = [];
    for (const h of list) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) if (c.status === "pending") items.push({ card: c, highlight: h });
    }
    return items;
  }

  /** Push every pending card of the given highlights to Anki via AnkiConnect. */
  async exportHighlights(list: Highlight[]): Promise<void> {
    const items = this.pendingItems(list);
    if (items.length === 0) {
      new Notice("Recall: nothing to export.");
      return;
    }
    const notice = new Notice(`Recall: exporting ${items.length} card${items.length === 1 ? "" : "s"} to “${this.settings.defaultDeck}”…`, 0);
    try {
      const res = await exportToAnki(this.anki, items, {
        settings: this.settings,
        vaultName: this.app.vault.getName(),
        deck: this.settings.defaultDeck,
      });
      this.store.touch();
      const bits = [`${res.added} added`];
      if (res.duplicates) bits.push(`${res.duplicates} already in Anki`);
      if (res.failed.length) bits.push(`${res.failed.length} failed`);
      new Notice(`Recall: ${bits.join(", ")}.`, res.failed.length ? 8000 : 4000);
      for (const f of res.failed) console.warn("Recall: export failed", f.error, f.card);
      if (res.failed.length) new Notice(`Recall: ${res.failed[0].error}`, 8000);
    } catch (e) {
      const msg = (e as Error).message;
      new Notice(`Recall: export failed. ${msg}\nUse “Export reviewed as Anki text file” from the inbox menu if Anki is closed.`, 10000);
      this.store.touch();
    } finally {
      notice.hide();
    }
  }

  /** Fallback when Anki is not running: write a text file Anki can import. */
  async exportAsTextFile(list: Highlight[]): Promise<void> {
    const items = this.pendingItems(list);
    if (items.length === 0) {
      new Notice("Recall: nothing to export.");
      return;
    }
    const ctx = { settings: this.settings, vaultName: this.app.vault.getName(), deck: this.settings.defaultDeck };
    const rows = items.map(({ card, highlight }) => {
      const n = buildNote(card, highlight, ctx);
      const order =
        card.kind === "qa"
          ? [this.settings.basicFrontField, this.settings.basicBackField, this.settings.basicExtraField]
          : [this.settings.clozeTextField, this.settings.clozeExtraField];
      return { notetype: n.modelName, deck: n.deckName, tags: n.tags, fields: order.filter(Boolean).map((f) => n.fields[f] ?? "") };
    });
    const folder = normalizePath(this.settings.exportFolder);
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const path = normalizePath(`${folder}/recall-${stamp}.txt`);
    const qa = rows.filter((r) => r.fields.length !== 2 || r.notetype !== this.settings.clozeModel);
    const cloze = rows.filter((r) => !qa.includes(r));
    // Anki's importer needs a consistent column count per file, so split by note type when the field counts differ.
    const files: Array<[string, typeof rows]> = [];
    if (qa.length && cloze.length && qa[0].fields.length !== cloze[0].fields.length) {
      files.push([path.replace(/\.txt$/, "-qa.txt"), qa], [path.replace(/\.txt$/, "-cloze.txt"), cloze]);
    } else files.push([path, rows]);
    for (const [p, rs] of files) await this.app.vault.create(p, buildAnkiTextImport(rs));
    for (const { card } of items) card.status = "exported";
    finalizeHighlights(items.map((i) => i.highlight));
    this.store.touch();
    new Notice(`Recall: wrote ${files.map(([p]) => p).join(" and ")}. In Anki: File → Import.`, 8000);
  }

  /** Used by the settings tab and tests; resolves a TFile from a path. */
  fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** Active markdown view, when there is one. */
  activeMarkdown(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }
}
