import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_CONFIG_DIR } from "./runtime-config.mjs";

const root = resolve(import.meta.dirname, "..");
const output = createWriteStream(resolve(root, "package.zip"));
const zip = archiver("zip", { zlib: { level: 9 } });

await new Promise((resolvePromise, reject) => {
  output.on("close", resolvePromise);
  output.on("error", reject);
  zip.on("error", reject);
  zip.pipe(output);
  // `dist/pdf2zh/` is the config the plugin manages at runtime (fonts, service
  // names, credential key names). In development it lives in the symlinked
  // dist, so it must never be shipped in a release. Archiver's third argument
  // is a per-entry callback, not glob options; returning false skips the entry.
  zip.directory(resolve(root, "dist"), false, (entry) =>
    entry.name === RUNTIME_CONFIG_DIR || entry.name.startsWith(`${RUNTIME_CONFIG_DIR}/`) ? false : entry);
  void zip.finalize();
});
console.log(`created package.zip (${zip.pointer()} bytes)`);
