import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The plugin manages a pdf2zh config at
 * `<workspace>/data/plugins/<plugin>/pdf2zh/config.json`.
 *
 * In development the plugin directory is a symlink to this repository's `dist/`,
 * so that runtime file lives inside the build output.  Vite's `emptyOutDir`
 * deletes it on every build, taking the user's translation config with it.
 * These helpers preserve it across a build.
 */
export const RUNTIME_CONFIG_DIR = "pdf2zh";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** Copy the runtime config out of `dist` before the build empties it. */
export async function saveRuntimeConfig(distDir, backupDir) {
  const source = resolve(distDir, RUNTIME_CONFIG_DIR);
  if (!(await exists(source))) return false;
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(backupDir, { recursive: true });
  await cp(source, resolve(backupDir, RUNTIME_CONFIG_DIR), { recursive: true });
  return true;
}

/** Put the preserved runtime config back once the build has finished. */
export async function restoreRuntimeConfig(distDir, backupDir) {
  const backup = resolve(backupDir, RUNTIME_CONFIG_DIR);
  if (!(await exists(backup))) return false;
  const target = resolve(distDir, RUNTIME_CONFIG_DIR);
  await rm(target, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(backup, target, { recursive: true });
  await rm(backupDir, { recursive: true, force: true });
  return true;
}
