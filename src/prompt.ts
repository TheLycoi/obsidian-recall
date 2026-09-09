/**
 * Message assembly for the highlighter. Kept out of llm.ts so the block order
 * can be tested without a backend or an Obsidian runtime: this file must stay
 * free of `obsidian` imports.
 */

export interface HighlighterMessageArgs {
  noteTitle: string;
  body: string;
  transcript: string | null;
  maxSpans: number;
  standingInstructions: string;
  instruction: string;
}

/**
 * Build the user message for a highlight request.
 *
 * Block order follows Anthropic's long-context guidance: the long inputs (note,
 * then transcript) go at the top and the instructions come last, so the model
 * reads the task with the material already in view.
 */
export function buildHighlighterMessage(a: HighlighterMessageArgs): string {
  const transcript = a.transcript?.trim() ? a.transcript.trim() : "";
  const standing = a.standingInstructions.trim();
  const instruction = a.instruction.trim();
  const limit = transcript
    ? `The transcript is a recording of the lecture that accompanies this note. Select at most ${a.maxSpans} spans, and fewer when the transcript supports fewer.`
    : `Select at most ${a.maxSpans} spans.`;
  return [
    `<note title="${a.noteTitle}">\n${a.body}\n</note>`,
    transcript ? `<transcript>\n${transcript}\n</transcript>` : "",
    limit,
    standing ? `Standing instructions: ${standing}` : "",
    instruction ? `Instructions for this note: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
