import { access, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "dist");
const pluginName = "siyuan-paper-manager";
const candidates = platform() === "darwin"
  ? [resolve(homedir(), "Library/Application Support/SiYuan/data/plugins", pluginName)]
  : platform() === "win32"
    ? [resolve(process.env.APPDATA || homedir(), "SiYuan/data/plugins", pluginName)]
    : [resolve(homedir(), ".config/SiYuan/data/plugins", pluginName)];

await access(target);
const link = candidates[0];
await mkdir(dirname(link), { recursive: true });
try {
  const info = await lstat(link);
  if (info.isSymbolicLink() && resolve(dirname(link), await readlink(link)) === target) {
    console.log(`link already exists: ${link}`);
    process.exit(0);
  }
  throw new Error(`target exists and is not this project's symlink: ${link}`);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    await symlink(target, link, "junction");
    console.log(`linked ${link} -> ${target}`);
  } else if (error instanceof Error && error.message.startsWith("target exists")) {
    throw error;
  }
}
