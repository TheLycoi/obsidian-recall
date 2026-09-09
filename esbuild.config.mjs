import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const banner = `/*
Recall — highlight-centric flashcard pipeline for Obsidian.
Bundled with esbuild; source lives in ~/dev/obsidian-recall.
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
