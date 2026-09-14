import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { restoreRuntimeConfig, saveRuntimeConfig } from "./runtime-config.mjs";

/**
 * Build the plugin while preserving the runtime-managed pdf2zh config.
 *
 * `vite build` empties `dist/`, and in development the plugin directory is a
 * symlink to `dist/`, so the config the plugin writes at runtime would be
 * deleted by a build.  Save it first, build, then restore it.
 *
 * All CLI arguments are forwarded, so `--watch --mode development` works too.
 */
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const vite = resolve(root, "node_modules/vite/bin/vite.js");

function run(script, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", cwd: root });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${script} exited with ${code}`)));
  });
}

const backup = await mkdtemp(resolve(tmpdir(), "paper-manager-dist-"));
const preserved = await saveRuntimeConfig(dist, backup);
if (preserved) console.log("[build] preserving dist/pdf2zh across the build");

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (preserved) {
    await restoreRuntimeConfig(dist, backup);
    console.log("[build] restored dist/pdf2zh");
  }
  await rm(backup, { recursive: true, force: true });
}

// Watch mode never exits on its own, so restore when the user stops it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { void cleanup().finally(() => process.exit(0)); });
}

try {
  await run(vite, ["build", ...process.argv.slice(2)]);
  await run(resolve(root, "scripts/copy-assets.mjs"), []);
} finally {
  await cleanup();
}
