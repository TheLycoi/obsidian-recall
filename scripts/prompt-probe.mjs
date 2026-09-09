import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const src = readFileSync("src/llm.ts", "utf8");
const grab = (name) => {
  const m = src.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!m) throw new Error("prompt not found: " + name);
  return m[1].replace(/\\`/g, "`");
};
const WRITER = grab("WRITER_SYSTEM");
const key = execFileSync("security", ["find-generic-password", "-s", "ANTHROPIC_API_KEY", "-w"], { encoding: "utf8" }).trim();
const client = new Anthropic({ apiKey: key });

const CardOut = z.object({ kind: z.enum(["qa", "cloze"]), front: z.string(), back: z.string(), text: z.string() });
const CardsOut = z.object({ cards: z.array(CardOut) });

const highlight = process.argv[2];
const before = process.argv[3] ?? "";
const after = process.argv[4] ?? "";
const parts = [
  `<source title="Decisional Balance and Processes of Change" section="Key claims">`,
  before ? `<context_before>\n${before}\n</context_before>` : "",
  `<highlight>\n${highlight}\n</highlight>`,
  after ? `<context_after>\n${after}\n</context_after>` : "",
  `</source>`,
  `Write at most 5 cards.`,
].filter(Boolean).join("\n\n");

const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 8000,
  system: [{ type: "text", text: WRITER }],
  output_config: { effort: "high", format: zodOutputFormat(CardsOut) },
  messages: [{ role: "user", content: parts }],
});
console.log("stop_reason:", res.stop_reason, "| usage:", JSON.stringify(res.usage));
for (const c of res.parsed_output.cards) {
  console.log(c.kind === "qa" ? `qa    | ${c.front} | ${c.back}` : `cloze | ${c.text}`);
}
