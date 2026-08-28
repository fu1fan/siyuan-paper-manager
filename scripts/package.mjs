import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = createWriteStream(resolve(root, "package.zip"));
const zip = archiver("zip", { zlib: { level: 9 } });

await new Promise((resolvePromise, reject) => {
  output.on("close", resolvePromise);
  output.on("error", reject);
  zip.on("error", reject);
  zip.pipe(output);
  zip.directory(resolve(root, "dist"), false);
  void zip.finalize();
});
console.log(`created package.zip (${zip.pointer()} bytes)`);
