import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await mkdir(resolve(dist, "templates"), { recursive: true });
await mkdir(resolve(dist, "i18n"), { recursive: true });

for (const file of ["plugin.json", "README.md", "index.css", "icon.png", "preview.png"]) {
  await cp(resolve(root, file), resolve(dist, file));
}
for (const file of ["paper-meta.md", "paper-note.md"]) {
  await cp(resolve(root, "templates", file), resolve(dist, "templates", file));
}
for (const file of ["zh_CN.json", "en_US.json"]) {
  await cp(resolve(root, "i18n", file), resolve(dist, "i18n", file));
}

// PDF.js dynamically loads these resources; they must ship with the plugin.
const pdfjs = resolve(root, "node_modules/pdfjs-dist");
await mkdir(resolve(dist, "pdfjs"), { recursive: true });
await cp(resolve(pdfjs, "legacy/build/pdf.worker.min.mjs"), resolve(dist, "pdfjs/pdf.worker.min.mjs"));
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(resolve(pdfjs, directory), resolve(dist, "pdfjs", directory), { recursive: true, filter: (source) => !/ \d+(?:\.|$)/.test(basename(source)) });
}
await mkdir(resolve(dist, "third-party"), { recursive: true });
await cp(resolve(root, "node_modules/pinyin-pro/LICENSE"), resolve(dist, "third-party/pinyin-pro.LICENSE"));
await cp(resolve(pdfjs, "LICENSE"), resolve(dist, "pdfjs/LICENSE"));

const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`version mismatch: plugin.json=${manifest.version}, package.json=${pkg.version}`);
}
await writeFile(resolve(dist, ".build-version"), `${pkg.version}\n`, "utf8");
