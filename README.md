# Recall — highlight-centric flashcards for Obsidian

Recall turns the sparse things you actually want to remember into Anki cards
without making you wait for the AI. It is built around three ideas:

1. **Highlights, not documents.** Every card belongs to a highlight: a span
   you selected, a `==markdown highlight==`, or a span the AI picked for you.
   The card writer only sees that span plus a little context, so it writes
   tight, grounded cards instead of a card for everything in the note.
2. **A flashcard inbox.** Sending a highlight is fire-and-forget. Cards are
   written in the background and land in an inbox you triage later, grouped
   by source note and by highlight, packed densely for fast scanning.
3. **Anki is the memory system.** Reviewed cards go straight into a deck via
   AnkiConnect (or a text-import file when Anki is closed). Nothing is
   rehearsed inside Obsidian.

## Workflow

```
read a note ──▶ select text ──▶ "Send selection to inbox"     (≈2 seconds)
                                        │
                     background: the model writes 1–5 cards for that span
                                        │
open inbox ──▶ scan / edit / delete ──▶ "Export" ──▶ Anki deck
```

### Capturing

**Highlighter mode** is the primary path. Click the pen in the ribbon (or run
*Toggle highlighter mode*), then drag across a passage. It is wrapped in
`==…==` and sent to the inbox with no key pressed. This works in the editor
(source and live preview), in reading view, and in Obsidian's PDF viewer,
where the highlight carries its page number instead of a line. The status bar
shows `🖊 highlighter` while the mode is on. Off by default: with it on, every
drag-selection is a capture. Guards: only a drag that started inside the
note or PDF counts, double-clicked words and selections under a minimum
length (setting, default 12 characters) are ignored, already-highlighted
spans are captured without being re-wrapped, and the same passage is never
captured twice in a row.

Commands, for when the mode is off:

| Command | What it does |
| --- | --- |
| **Send selection to inbox** | Captures the selection (or the paragraph under the cursor; in reading view, the selected text), wraps it in `==…==`, and queues card writing. Also in the editor right-click menu. |
| **Send PDF selection to inbox** (also *…with instructions…*) | Captures the text selected in the PDF viewer with its page number and the page's text as context. |
| **Send selection to inbox with instructions…** | Same, plus a one-line instruction for the writer ("one cloze on the number", "cards in Dutch"). |
| **Send all ==highlights== in this note to inbox** | Sweeps a note you highlighted while reading and queues every span not already in the inbox. |
| **AI-highlight this note and write cards** | The "highlight" operation: the model picks spans worth remembering, each is verified verbatim against the note, marked, and queued. Use this for dense material. |
| **AI-highlight this note with instructions…** | Same, with guidance for the highlighter ("only definitions and numbers"). |

Every highlight remembers its note, line, nearest heading and (optionally) a
`^recall-…` block ID, so the inbox can jump straight back to the source. PDF
highlights remember the page and open the PDF at that page.

### Triage

Open the inbox from the ribbon, the status bar (`Recall ✎ 2 · ⧉ 7` = 2
writing, 7 to review), or the **Open inbox** command.

- Cards sit beside the highlight they came from. Click the highlight to open
  the note at that line.
- Per card: edit in place, delete, rewrite with an instruction, convert
  Q&A ⇄ cloze. A cloze whose deletions are not found verbatim in the
  highlight gets a *not in highlight* badge (a deterministic check, no model).
- Per highlight: export, write more cards, add a card by hand, retry, dismiss.
- Per note: export everything reviewed from that note.
- Keyboard: `j`/`k` move, `e` edit, `x` delete, `o` open source,
  `Enter` export the focused highlight, `⌘⏎` export everything reviewed.

### Exporting

- **AnkiConnect** (default): Anki must be open with the
  [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. Recall
  talks to it through Obsidian's own request layer, so no CORS origin needs
  whitelisting. Duplicates are checked per deck before adding.
- **Text file** (fallback): *Inbox menu → Export reviewed as Anki text file*
  writes a tab-separated file with `#notetype`/`#deck`/`#tags` directives into
  `recall-exports/`; import it with *File → Import* in Anki.

Cards are tagged `recall` and `source::<note-slug>`. The `source::` tag is the
namespace the Anki Wiki Sync add-on resolves back to vault pages, so synced
deck pages link to the note the card came from. The extra field carries the
verbatim highlight and an `obsidian://` link to the source.

## Setup

1. Settings → Recall → **Provider**. Two options:
   - **Codex (ChatGPT subscription)** — no API key. Recall runs OpenAI's
     Codex CLI (`codex exec`) signed in with your ChatGPT account. Leave
     *Codex CLI path* empty and Recall finds `codex` on the PATH or the copy
     bundled inside the ChatGPT desktop app
     (`/Applications/ChatGPT.app/Contents/Resources/codex`); otherwise paste
     the output of `which codex`. Sign in once through the ChatGPT app or
     `codex login`. Default model `gpt-5.5`; effort levels the model does not
     support are rounded down. Each request runs in a throwaway temp folder
     with a read-only sandbox, `--ephemeral` (no session files) and
     `--ignore-user-config` (your `~/.codex/config.toml` hooks, plugins and
     MCP servers are not loaded), so the agent never sees the vault.
   - **Anthropic (API key)** — paste a key, or leave the field empty and
     Recall reads `ANTHROPIC_API_KEY` from the environment or from the macOS
     keychain (a generic password whose service is `ANTHROPIC_API_KEY` or
     `Recall Anthropic API key`). The keychain route keeps the key out of
     `data.json`, which iCloud syncs in plaintext:
     `security add-generic-password -s ANTHROPIC_API_KEY -a recall -w`.
     Default model `claude-opus-5`.

   Effort defaults to `high` (highlights are small, so this is cheap). Click
   **Test** to confirm the provider answers.
2. Open Anki, then Settings → Recall → **Detect** note types. Recall prefers
   `Janus - Basic (v2)` / `Janus - Cloze (v2)` when present, otherwise
   `Basic` / `Cloze`, and maps the front/back/extra fields.
3. Pick a default deck (the inbox header lets you change it per session).

## Development

```
npm install
npm run dev            # watch build → main.js
npm run build          # type-check + minified bundle
npm test               # unit tests for the pure helpers
npm run install:vault  # build and copy into the vault's .obsidian/plugins/recall
```

State: settings in `data.json`, the inbox in `inbox.json`, both inside the
plugin folder. Notes are only touched when you choose to mark highlights.

Layout:

- `src/capture.ts` — selection / reading-view / PDF / `==highlight==` / AI-highlight capture
- `src/highlighter.ts` — highlighter mode (drag-to-capture gesture, ribbon toggle)
- `src/pdf.ts` — reads a selection out of Obsidian's pdf.js viewer
- `src/llm.ts` — prompts, zod output schemas, provider dispatch, error text
- `src/backend.ts` — the `LlmBackend` interface (`probe`, `complete`, `abort`)
- `src/anthropic.ts` — Anthropic backend (SDK over Obsidian `requestUrl`, native structured outputs)
- `src/codex.ts` — Codex backend (`codex exec --json --output-schema` over stdin, JSONL parsing, effort clamping)
- `src/keys.ts` — Anthropic API key resolution (settings → environment → keychain)
- `src/generator.ts` — background queue
- `src/inboxView.ts` — the inbox
- `src/anki.ts` — AnkiConnect client, note building, export
- `src/store.ts`, `src/model.ts`, `src/util.ts`, `src/settings.ts`, `src/modals.ts`
