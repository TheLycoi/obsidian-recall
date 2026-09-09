import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RecallPlugin from "./main";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "anthropic" | "codex";
export type MarkMode = "none" | "highlight" | "highlight+block";

export interface RecallSettings {
  // LLM
  /** "anthropic": Messages API with an API key. "codex": OpenAI's Codex CLI signed in with a ChatGPT subscription. */
  provider: Provider;
  apiKey: string;
  /** Claude model ID (Anthropic provider). */
  model: string;
  /** Absolute path to the codex binary; empty = auto-detect (PATH, then the ChatGPT app bundle). */
  codexPath: string;
  /** Codex model slug, e.g. gpt-5.5. */
  codexModel: string;
  effort: Effort;
  maxCardsPerHighlight: number;
  contextChars: number;
  language: string;
  writerInstructions: string;
  highlighterInstructions: string;
  maxAiHighlights: number;
  transcriptMaxChars: number;
  concurrency: number;
  notifyWhenReady: boolean;

  // Capture
  markMode: MarkMode;
  openInboxOnCapture: boolean;
  /** Drag-to-capture. Off by default: with it on, every drag-selection is a capture. */
  highlighterMode: boolean;
  /** Selections shorter than this are ignored by highlighter mode (a double-clicked word, a stray drag). */
  highlighterMinChars: number;

  // Anki
  ankiConnectUrl: string;
  defaultDeck: string;
  basicModel: string;
  basicFrontField: string;
  basicBackField: string;
  basicExtraField: string;
  clozeModel: string;
  clozeTextField: string;
  clozeExtraField: string;
  extraTags: string;
  includeSourceTag: boolean;
  includeExtra: boolean;
  exportFolder: string;
}

export const DEFAULT_SETTINGS: RecallSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-opus-5",
  codexPath: "",
  codexModel: "gpt-5.5",
  effort: "high",
  maxCardsPerHighlight: 5,
  contextChars: 700,
  language: "",
  writerInstructions: "",
  highlighterInstructions: "",
  maxAiHighlights: 12,
  transcriptMaxChars: 150000,
  concurrency: 2,
  notifyWhenReady: true,

  markMode: "highlight",
  openInboxOnCapture: false,
  highlighterMode: false,
  highlighterMinChars: 12,

  ankiConnectUrl: "http://127.0.0.1:8765",
  defaultDeck: "Default",
  basicModel: "Basic",
  basicFrontField: "Front",
  basicBackField: "Back",
  basicExtraField: "",
  clozeModel: "Cloze",
  clozeTextField: "Text",
  clozeExtraField: "Back Extra",
  extraTags: "recall",
  includeSourceTag: true,
  includeExtra: true,
  exportFolder: "recall-exports",
};

export class RecallSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RecallPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl).setName("Card writer").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Anthropic uses an API key. Codex uses OpenAI's Codex CLI signed in with your ChatGPT subscription, so no key is needed. Test sends one tiny request.")
      .addDropdown((d) =>
        d
          .addOptions({ anthropic: "Anthropic (API key)", codex: "Codex (ChatGPT subscription)" })
          .setValue(s.provider)
          .onChange((v) => {
            s.provider = v as Provider;
            save();
            this.display();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          try {
            const r = await this.plugin.llm.probe();
            new Notice(`Recall: ${r.model} answered (${r.via}).`, 6000);
          } catch (e) {
            new Notice(`Recall: ${(e as Error).message}`, 8000);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    if (s.provider === "codex") {
      new Setting(containerEl)
        .setName("Codex CLI path")
        .setDesc(
          "Leave empty to auto-detect: `codex` on the PATH, then the copy bundled in the ChatGPT app (/Applications/ChatGPT.app/Contents/Resources/codex). Otherwise paste the output of `which codex`. Sign in through the ChatGPT app or `codex login`.",
        )
        .addText((t) =>
          t.setPlaceholder("auto-detect").setValue(s.codexPath).onChange((v) => {
            s.codexPath = v.trim();
            save();
          }),
        );

      new Setting(containerEl)
        .setName("Codex model")
        .setDesc("Model slug passed to codex exec. gpt-5.5 is the lightest on your usage limit; gpt-5.6-luna and gpt-5.6-terra are newer and heavier.")
        .addText((t) =>
          t.setPlaceholder(DEFAULT_SETTINGS.codexModel).setValue(s.codexModel).onChange((v) => {
            s.codexModel = v.trim() || DEFAULT_SETTINGS.codexModel;
            save();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .setDesc(
          "Leave empty to read ANTHROPIC_API_KEY from the environment or the macOS keychain (service “ANTHROPIC_API_KEY” or “Recall Anthropic API key”). A key typed here is stored in data.json, which this vault syncs through iCloud in plaintext.",
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("sk-ant-… or leave empty for keychain")
            .setValue(s.apiKey)
            .onChange((v) => {
              s.apiKey = v.trim();
              save();
            });
        });

      new Setting(containerEl)
        .setName("Model")
        .setDesc("Claude model ID used for highlighting and card writing.")
        .addText((t) =>
          t.setValue(s.model).onChange((v) => {
            s.model = v.trim() || DEFAULT_SETTINGS.model;
            save();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Effort")
      .setDesc(
        s.provider === "codex"
          ? "Reasoning effort passed to Codex. Levels the chosen model does not support (gpt-5.5 stops at xhigh) are rounded down automatically."
          : "How much reasoning the model spends per highlight. Highlights are small, so high is cheap.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })
          .setValue(s.effort)
          .onChange((v) => {
            s.effort = v as Effort;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Max cards per highlight")
      .setDesc("Upper bound. The writer makes fewer when the highlight only supports one or two.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 12, 1)
          .setValue(s.maxCardsPerHighlight)
          .setDynamicTooltip()
          .onChange((v) => {
            s.maxCardsPerHighlight = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Context window (characters)")
      .setDesc("Text before and after the highlight that the writer sees for disambiguation. Cards are only written about the highlight itself.")
      .addText((t) =>
        t.setValue(String(s.contextChars)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 0) {
            s.contextChars = n;
            save();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Card language")
      .setDesc("Leave empty to match the language of the highlight.")
      .addText((t) =>
        t.setPlaceholder("e.g. Dutch").setValue(s.language).onChange((v) => {
          s.language = v.trim();
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for the card writer")
      .setDesc("Appended to every request, e.g. 'Prefer cloze for numbers and dates.'")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.writerInstructions).onChange((v) => {
          s.writerInstructions = v;
          save();
        });
      });

    new Setting(containerEl)
      .setName("Standing instructions for the AI highlighter")
      .setDesc("Used by 'AI-highlight this note', e.g. 'Only pick definitions and numbers.'")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.highlighterInstructions).onChange((v) => {
          s.highlighterInstructions = v;
          save();
        });
      });

    new Setting(containerEl)
      .setName("Max AI highlights per note")
      .addSlider((sl) =>
        sl
          .setLimits(3, 40, 1)
          .setValue(s.maxAiHighlights)
          .setDynamicTooltip()
          .onChange((v) => {
            s.maxAiHighlights = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Transcript size limit")
      .setDesc(
        "Characters of an attached lecture transcript sent to the highlighter; longer transcripts are cut at a sentence boundary.",
      )
      .addText((t) =>
        t.setValue(String(s.transcriptMaxChars)).onChange((v) => {
          const n = Number(v);
          s.transcriptMaxChars = Number.isInteger(n) && n > 0 ? n : DEFAULT_SETTINGS.transcriptMaxChars;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Parallel requests")
      .setDesc("How many highlights are written at once in the background. With Codex, drop to 1 if you ever see refresh_token_failed.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 4, 1)
          .setValue(s.concurrency)
          .setDynamicTooltip()
          .onChange((v) => {
            s.concurrency = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Notify when cards are ready")
      .addToggle((t) =>
        t.setValue(s.notifyWhenReady).onChange((v) => {
          s.notifyWhenReady = v;
          save();
        }),
      );

    new Setting(containerEl).setName("Capture").setHeading();

    new Setting(containerEl)
      .setName("Highlighter mode")
      .setDesc(
        "Drag across a passage in a note (editing or reading view) or in the PDF viewer and it is highlighted and sent to the inbox, no key pressed. Also toggled from the ribbon pen. Off by default because with it on every drag-selection is a capture.",
      )
      .addToggle((t) =>
        t.setValue(s.highlighterMode).onChange((v) => {
          void this.plugin.highlighter.toggle(v);
        }),
      );

    new Setting(containerEl)
      .setName("Highlighter: ignore selections shorter than")
      .setDesc("Characters. Keeps a double-clicked word or a stray drag from becoming a card.")
      .addSlider((sl) =>
        sl
          .setLimits(3, 80, 1)
          .setValue(s.highlighterMinChars)
          .setDynamicTooltip()
          .onChange((v) => {
            s.highlighterMinChars = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Mark captured text in the note")
      .setDesc("'Highlight' wraps the selection in ==…==. 'Highlight + block ID' also appends a ^recall-… block ID so the inbox can link straight back to the span.")
      .addDropdown((d) =>
        d
          .addOptions({ none: "Do not touch the note", highlight: "Highlight (==…==)", "highlight+block": "Highlight + block ID" })
          .setValue(s.markMode)
          .onChange((v) => {
            s.markMode = v as MarkMode;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Open the inbox after capturing")
      .setDesc("Off by default: the point of the inbox is that you keep reading and triage later.")
      .addToggle((t) =>
        t.setValue(s.openInboxOnCapture).onChange((v) => {
          s.openInboxOnCapture = v;
          save();
        }),
      );

    new Setting(containerEl).setName("Anki").setHeading();

    new Setting(containerEl)
      .setName("AnkiConnect URL")
      .setDesc("Anki must be open with the AnkiConnect add-on installed.")
      .addText((t) =>
        t.setValue(s.ankiConnectUrl).onChange((v) => {
          s.ankiConnectUrl = v.trim() || DEFAULT_SETTINGS.ankiConnectUrl;
          save();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            const v = await this.plugin.anki.version();
            new Notice(`AnkiConnect reachable (version ${v}).`);
          } catch (e) {
            new Notice(`AnkiConnect not reachable: ${(e as Error).message}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Default deck")
      .setDesc("Deck new cards go to unless you pick another in the inbox. Created if missing.")
      .addText((t) =>
        t.setValue(s.defaultDeck).onChange((v) => {
          s.defaultDeck = v.trim() || DEFAULT_SETTINGS.defaultDeck;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Detect note types from Anki")
      .setDesc("Looks for 'Janus - Basic (v2)' / 'Janus - Cloze (v2)' first, then falls back to Basic / Cloze, and fills in the field names below.")
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          try {
            await this.plugin.detectNoteTypes();
            this.display();
            new Notice("Recall: note types detected.");
          } catch (e) {
            new Notice(`Recall: ${(e as Error).message}`);
          }
        }),
      );

    const field = (name: string, key: keyof RecallSettings, desc = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(s[key])).onChange((v) => {
            (s as unknown as Record<string, string>)[key] = v.trim();
            save();
          }),
        );

    field("Q&A note type", "basicModel");
    field("Q&A front field", "basicFrontField");
    field("Q&A back field", "basicBackField");
    field("Q&A extra field", "basicExtraField", "Optional. Receives the highlight quote and source link.");
    field("Cloze note type", "clozeModel");
    field("Cloze text field", "clozeTextField");
    field("Cloze extra field", "clozeExtraField", "Optional.");

    new Setting(containerEl)
      .setName("Tags")
      .setDesc("Space-separated tags added to every exported note.")
      .addText((t) =>
        t.setValue(s.extraTags).onChange((v) => {
          s.extraTags = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Add a source:: tag")
      .setDesc("Adds source::<note-slug> so the Anki Wiki Sync add-on can link the card back to its vault page.")
      .addToggle((t) =>
        t.setValue(s.includeSourceTag).onChange((v) => {
          s.includeSourceTag = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Fill the extra field with the highlight and source link")
      .addToggle((t) =>
        t.setValue(s.includeExtra).onChange((v) => {
          s.includeExtra = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Text export folder")
      .setDesc("Vault folder for Anki text-import files when AnkiConnect is unavailable.")
      .addText((t) =>
        t.setValue(s.exportFolder).onChange((v) => {
          s.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          save();
        }),
      );
  }
}
