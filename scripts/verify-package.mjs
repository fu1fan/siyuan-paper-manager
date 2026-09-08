import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const required = [
  "plugin.json",
  "pdfjs/pdf.worker.min.mjs",
  "pdfjs/cmaps/UniGB-UCS2-H.bcmap",
  "pdfjs/standard_fonts/FoxitSerif.pfb",
  "pdfjs/wasm/openjpeg.wasm",
  "pdfjs/LICENSE",
  "third-party/pinyin-pro.LICENSE",
  "index.js",
  "index.css",
  "README.md",
  "icon.png",
  "preview.png",
  "templates/paper-meta.md",
  "templates/paper-note.md",
  "i18n/zh_CN.json",
  "i18n/en_US.json",
];

for (const file of required) {
  const path = resolve(dist, file);
  await access(path);
  if ((await stat(path)).size === 0) throw new Error(`empty build artifact: ${file}`);
}

const manifest = JSON.parse(await readFile(resolve(dist, "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
  throw new Error("package identity/version mismatch");
}
console.log(`verified dist for ${manifest.name}@${manifest.version}`);
