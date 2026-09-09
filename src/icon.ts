import { addIcon } from "obsidian";

export const RECALL_ICON = "recall";

/** Recall's icon: a single flashcard. Uses currentColor so it follows the theme. */
const SVG = `
<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="12" y="24" width="76" height="52" rx="10"/>
  <path d="M30 50h40"/>
</g>`;

export function registerRecallIcon(): void {
  addIcon(RECALL_ICON, SVG);
}
