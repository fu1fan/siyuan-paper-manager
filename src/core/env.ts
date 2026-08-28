import { getFrontend } from "siyuan";

export type NodeRequire = (id: string) => unknown;

export function isDesktopFrontend(): boolean {
  try {
    return getFrontend().includes("desktop");
  } catch {
    return false;
  }
}

export function getNodeRequire(): NodeRequire | null {
  const candidate = (globalThis as typeof globalThis & {
    window?: { require?: NodeRequire };
    require?: NodeRequire;
  }).window?.require ?? (globalThis as typeof globalThis & { require?: NodeRequire }).require;
  return typeof candidate === "function" ? candidate.bind(globalThis) : null;
}

export function canUseNode(): boolean {
  return isDesktopFrontend() && getNodeRequire() !== null;
}

export function requireNode<T>(id: string, requireFn: NodeRequire | null = getNodeRequire()): T {
  if (!requireFn) throw new Error(`Node 模块不可用: ${id}`);
  return requireFn(id) as T;
}

export function getPluginTempDir(pluginName: string, requireFn?: NodeRequire): string {
  const os = requireNode<typeof import("node:os")>("os", requireFn ?? getNodeRequire());
  const path = requireNode<typeof import("node:path")>("path", requireFn ?? getNodeRequire());
  return path.join(os.tmpdir(), pluginName);
}

export function readFileBytes(pathname: string, requireFn?: NodeRequire): Uint8Array {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn ?? getNodeRequire());
  return new Uint8Array(fs.readFileSync(pathname));
}

export function unlinkIfExists(pathname: string, requireFn?: NodeRequire): void {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn ?? getNodeRequire());
  try {
    fs.unlinkSync(pathname);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) console.warn("[paper-manager] 临时文件清理失败", pathname, error);
  }
}

export function removeDirIfExists(pathname: string, requireFn?: NodeRequire): void {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn ?? getNodeRequire());
  try {
    fs.rmSync(pathname, { recursive: true, force: true });
  } catch (error) {
    console.warn("[paper-manager] 临时目录清理失败", pathname, error);
  }
}

export async function sha256(bytes: Uint8Array, requireFn?: NodeRequire): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const crypto = requireNode<typeof import("node:crypto")>("crypto", requireFn ?? getNodeRequire());
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
