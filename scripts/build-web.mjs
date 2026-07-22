import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const outdir = new URL("../web/dist/", import.meta.url);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: ["web/src/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "web/dist/app.js",
  sourcemap: false,
  minify: true,
  loader: { ".ttf": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
});

await build({
  entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "web/dist/editor.worker.js",
  minify: true,
});

await cp(new URL("../web/src/index.html", import.meta.url), new URL("index.html", outdir));
await cp(new URL("../web/src/styles.css", import.meta.url), new URL("styles.css", outdir));
