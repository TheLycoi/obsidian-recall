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

### Transcript-guided highlighting

Attach a lecture transcript to a note and the two **AI-highlight** commands
use it as evidence of what the lecturer emphasised, so the model prefers
spans the lecturer dwells on, repeats, calls important, or says will be
tested, instead of spreading picks evenly across the note. Spans are still
copied verbatim from the note; the transcript itself is never quoted.

Run **Add transcript for document highlighting** on an active `.md` note.
The modal shows the current transcript (origin, character count, added
date, whether it was cut to the size limit) when one is attached, and lets
you:

- Paste a transcript into the textarea.
- **Choose a file from the vault…**, which opens a fuzzy file picker
  restricted to `md`, `txt`, `vtt`, and `srt` files and reads the chosen
  file's contents into the textarea.
- **Save** the transcript (an empty textarea shows a notice instead), **Clear**
  it (only shown when a transcript already exists), or **Cancel**. `Cmd`/`Ctrl+Enter`
  in the textarea also saves.

Saving cleans the text before it's stored: WebVTT headers and `NOTE`
comment blocks are dropped, SRT cue numbers and `-->` timestamp lines are
removed, leading `[m:ss]`/`[h:mm:ss]`/`(m:ss)`/`(h:mm:ss)` timestamps are
stripped from the start of a line, and `<v>`, `<c>`, `<b>`, and `<i>` tags
are removed. Speaker `Name:` prefixes are left in place.

The **Transcript size limit** setting (default 150,000 characters) caps how
much of the transcript is sent to the highlighter; longer transcripts are
cut at a sentence boundary rather than mid-sentence.

Once a transcript is attached, both **AI-highlight this note and write
cards** and **AI-highlight this note with instructions…** pick it up
automatically, with no separate step, and the notice they show changes to
mention the transcript.

Limitations:

- Only markdown notes can be AI-highlighted, so a transcript attached to a
  PDF has no effect.
- Transcripts are keyed by the note's file path. Renaming or moving a note
  detaches its transcript; re-add it with **Add transcript for document
  highlighting** afterward.

### Card quality

Every card goes through a fixed chain before it reaches the inbox: the
writer drafts, a critique pass reviews the draft, and a deterministic
linter checks the result. The linter always runs and costs nothing; the
critique is on by default and can be turned off. All of this happens
inside the background queue
(`Generator.run` in `src/generator.ts`), so capture itself never waits on
it — a highlight just takes a little longer to turn into ready cards when
the critique is on.

**Critique pass** (setting, on by default) sends the whole set of cards
drafted for one highlight to the model in a single call and gets back a
verdict per card: `keep`, `revise`, or `drop`, plus the Bloom level the card
sits at (`src/llm.ts:44-58`, `src/llm.ts:162-237`). It checks grounding
(every answer and cloze deletion must be stated in the highlight), whether
the cards interfere with each other (two cards whose questions read alike
but want different answers, or that share an answer), and near-tautology
(an answer that just restates a word already in the question)
(`src/llm.ts:174-193`). A `revise` verdict replaces the card's fields and
records the reason on `critiqueReason`; a `drop` verdict does not delete
the card — it sets `status: "flagged"` and keeps the reason attached
(`src/generator.ts:95-110`). If the critique call fails (network, quota),
the drafted cards are kept as written and simply skip critique rather than
being lost (`src/generator.ts:112-117`). To avoid spending a model call on
a highlight that clearly doesn't need one, the critique is skipped when a
highlight drafts zero or one card and that one card already lints clean
(`src/generator.ts:82-84`).

**Bloom level** is the critique's judgment of how much a card actually
asks of the reader, reported using Bloom's taxonomy: a six-level ladder of
cognitive demand running remember → understand → apply → analyze →
evaluate → create. The one failure this is meant to catch is a highlight
that explains a mechanism or a reason getting turned into a card that only
asks what something is called — the reader can recite the label back
without knowing how the thing works. This is not a push toward the higher
end of the ladder: a highlight that states a plain definition and nothing
more is correctly a "remember" card, and the critique says so rather than
asking for a harder question the source doesn't support
(`src/llm.ts:185`, `src/model.ts:31-32`).

**Deterministic lint** (`src/lint.ts`) runs on every card regardless of
whether the critique is on, both on the freshly drafted cards and again on
any card the critique revised, since a revision changes the text the
grounding check needs to see (`src/generator.ts:79`, `:105`). It is pure
regex- and word-count-based, no model call. Nine checks can fail a card:

| id | what it catches |
| --- | --- |
| `cloze-not-grounded` | a `{{cN::…}}` deletion whose text isn't found in the highlight |
| `cloze-count` | a cloze card with fewer than 1 or more than 3 distinct deletions |
| `cloze-numbering` | deletion numbers that skip (e.g. 1, 3, no 2) |
| `cloze-framing` | a deletion body over 6 words, or one containing a linking word like "is"/"which"/"because" — a sign it hides a clause, not a short atom |
| `qa-empty` | an empty question/answer, or a cloze card with no deletion at all |
| `qa-answer-long` | a Q&A answer over 12 words |
| `qa-yes-no` | a question starting with "is", "are", "does", "can", and the like |
| `card-long` | question + answer + cloze text together over 60 words |
| `answer-in-question` | the answer sits verbatim inside the question, so there's nothing to retrieve |

Two more checks are warnings rather than failures — they flag a card
without blocking it: `duplicate-card` (this card repeats a sibling drafted
in the same batch) and `shared-answer` (two Q&A cards in the same batch
have the same answer, which risks confusing them in review). Labels for
all eleven ids, shown in the inbox, live in `LINT_LABELS` in `src/lint.ts`.

**The three settings**, all in Settings → Recall → Card quality:

| setting | default | effect |
| --- | --- | --- |
| Critique pass | **on** | runs the critique described above; adds one model call per highlight |
| Lint mode | badge only | what happens to a card that fails a lint check: badge it but keep it pending, collapse it behind a "N flagged" toggle, or flag it so it can't be exported |
| Learn from my decisions | **on** | shows the writer and critique a few cards you kept or edited, and a few you deleted, from your own inbox history |

The quality chain is on by default, because a card you delete during review
cost more than the model call that would have caught it. The linter is free
and always runs. The critique costs one extra model call per highlight;
turn it off if you are drafting in bulk and would rather triage by hand.

Lint mode stays at **badge only** by default, which is the conservative
choice: a card that fails a check is still yours to keep. Nothing in this
chain ever deletes a card (`src/settings.ts:99-101`).

The cost of turning the critique on is time, not capture speed: it is one
extra model call per highlight, so cards take longer to appear after you
send a highlight. Capture — selecting text, dragging with the highlighter,
sending a PDF selection — is unaffected either way, because everything
above happens in the background queue after capture has already returned
(`src/settings.ts:279`).

A **flagged** card (`status: "flagged"`) is one the critique dropped or
that failed lint under a mode other than "badge only". It stays in the
inbox with its reason attached rather than being deleted — nothing is
silently thrown away — but it is excluded from export: only cards with
`status === "pending"` are ever sent to Anki, whether through AnkiConnect
or the text-file fallback, so a flagged card cannot reach Anki until you
review and fix it (`src/model.ts:9`, `src/main.ts:284-292`).

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
