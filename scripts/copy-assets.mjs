import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await mkdir(resolve(dist, "templates"), { recursive: true });
await mkdir(resolve(dist, "i18n"), { recursive: true });

for (const file of ["plugin.json", "README.md", "index.css", "icon.png"]) {
  await cp(resolve(root, file), resolve(dist, file));
}
for (const file of ["paper-meta.md", "paper-note.md"]) {
  await cp(resolve(root, "templates", file), resolve(dist, "templates", file));
}
for (const file of ["zh_CN.json", "en_US.json"]) {
  await cp(resolve(root, "i18n", file), resolve(dist, "i18n", file));
}

const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`version mismatch: plugin.json=${manifest.version}, package.json=${pkg.version}`);
}
await writeFile(resolve(dist, ".build-version"), `${pkg.version}\n`, "utf8");
