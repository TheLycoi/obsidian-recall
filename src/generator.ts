import { Notice } from "obsidian";
import type RecallPlugin from "./main";
import { makeCard, type Highlight } from "./model";
import { describeError } from "./llm";

/**
 * Background queue: fire a highlight in, come back later to cards in the
 * inbox. Runs `concurrency` highlights at a time and survives reloads because
 * queued state lives in the store.
 */
export class Generator {
  private running = new Set<string>();
  private stopped = false;

  constructor(private plugin: RecallPlugin) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  enqueue(h: Highlight): void {
    h.status = "queued";
    h.error = null;
    this.plugin.store.touch();
    this.kick();
  }

  /** Ask for more cards on a highlight that already has some. */
  more(h: Highlight): void {
    this.enqueue(h);
  }

  kick(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.plugin.settings.concurrency);
    for (const h of this.plugin.store.all()) {
      if (this.running.size >= limit) break;
      if (h.status !== "queued" || this.running.has(h.id)) continue;
      this.running.add(h.id);
      void this.run(h).finally(() => {
        this.running.delete(h.id);
        this.kick();
      });
    }
    this.plugin.refreshStatusBar();
  }

  private async run(h: Highlight): Promise<void> {
    h.status = "generating";
    this.plugin.store.touch();
    try {
      const existing = h.cards.filter((c) => c.status !== "deleted");
      const drafts = await this.plugin.llm.writeCards(h, existing);
      for (const d of drafts) {
        h.cards.push(
          makeCard(h.id, {
            kind: d.kind,
            front: d.kind === "qa" ? d.front.trim() : "",
            back: d.kind === "qa" ? d.back.trim() : "",
            text: d.kind === "cloze" ? d.text.trim() : "",
          }),
        );
      }
      h.status = "ready";
      h.generatedAt = new Date().toISOString();
      h.error = null;
      if (this.plugin.settings.notifyWhenReady) {
        const label = h.title || h.text.slice(0, 40);
        new Notice(`Recall: ${drafts.length} card${drafts.length === 1 ? "" : "s"} ready for “${label}”.`);
      }
    } catch (e) {
      if (this.stopped) {
        // Unloading: the request was aborted, so put the highlight back in the queue for next time.
        h.status = "queued";
        h.error = null;
      } else {
        h.status = "error";
        h.error = describeError(e);
        console.error("Recall: card writing failed", e);
      }
    }
    this.plugin.store.touch();
  }
}
