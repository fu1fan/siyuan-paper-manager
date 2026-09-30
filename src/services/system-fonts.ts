import { getNodeRequire, requireNode, type NodeRequire } from "../core/env";

export interface SystemFont {
  path: string;
  name: string;
  family: string;
  postscriptName: string;
}

/** Read names from the OpenType name table, preferring Simplified Chinese labels. */
export function parseFontNames(table: Uint8Array): Omit<SystemFont, "path"> | null {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  if (table.length < 6) return null;
  const count = view.getUint16(2);
  const strings = view.getUint16(4);
  if (6 + count * 12 > table.length || strings > table.length) return null;
  const names = new Map<number, { value: string; score: number }>();
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 12;
    const platform = view.getUint16(offset);
    const encoding = view.getUint16(offset + 2);
    const language = view.getUint16(offset + 4);
    const id = view.getUint16(offset + 6);
    const length = view.getUint16(offset + 8);
    const start = strings + view.getUint16(offset + 10);
    if (![1, 4, 6].includes(id) || start + length > table.length) continue;
    const unicode = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding));
    if (!unicode && !(platform === 1 && encoding === 0)) continue;
    try {
      const value = new TextDecoder(unicode ? "utf-16be" : "macintosh").decode(table.subarray(start, start + length)).replace(/\0/g, "").trim();
      const score = language === 0x0804 ? 100 : (language & 0xff) === 4 ? 80 : language === 0x0409 ? 60 : platform === 0 ? 40 : 20;
      if (value && (!names.has(id) || score > names.get(id)!.score)) names.set(id, { value, score });
    } catch { /* Unsupported encoding or malformed font. */ }
  }
  const family = names.get(1)?.value || names.get(4)?.value;
  if (!family) return null;
  return { name: names.get(4)?.value || family, family, postscriptName: names.get(6)?.value.normalize("NFKC") || "" };
}

export function systemFontDirectories(platform: string, home: string, join: (...parts: string[]) => string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") return [join(home, "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
  if (platform === "win32") return [join(env.WINDIR || "C:\\Windows", "Fonts"), join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts")];
  return [join(home, ".local", "share", "fonts"), join(home, ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
}

/** Scan actual font files; TTC collections use their first face, as fontfile does. */
export async function scanSystemFonts(requireFn: NodeRequire = getNodeRequire()!, directories?: string[]): Promise<SystemFont[]> {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const fonts: SystemFont[] = [];
  const seen = new Set<string>();
  async function readFont(file: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      const realPath = await fs.promises.realpath(file);
      if (seen.has(realPath)) return;
      seen.add(realPath);
      handle = await fs.promises.open(realPath, "r");
      const size = (await handle.stat()).size;
      const read = async (position: number, length: number) => {
        if (position < 0 || length < 0 || position + length > size) throw new Error("Invalid font table");
        const bytes = new Uint8Array(length);
        const { bytesRead } = await handle!.read(bytes, 0, length, position);
        if (bytesRead !== length) throw new Error("Incomplete font table");
        return bytes;
      };
      const header = await read(0, 16);
      const headerView = new DataView(header.buffer);
      const sfntOffset = headerView.getUint32(0) === 0x74746366 ? headerView.getUint32(12) : 0;
      const sfnt = await read(sfntOffset, 12);
      const sfntView = new DataView(sfnt.buffer);
      if (![0x00010000, 0x4f54544f, 0x74727565].includes(sfntView.getUint32(0))) return;
      const count = sfntView.getUint16(4);
      if (count > 256) return;
      const tables = new DataView((await read(sfntOffset + 12, count * 16)).buffer);
      for (let i = 0; i < count; i++) {
        if (tables.getUint32(i * 16) !== 0x6e616d65) continue;
        const offset = tables.getUint32(i * 16 + 8);
        const length = tables.getUint32(i * 16 + 12);
        if (length > 1024 * 1024) return;
        const names = parseFontNames(await read(offset, length));
        if (names && !names.family.startsWith(".")) fonts.push({ path: realPath, ...names });
        break;
      }
    } catch { /* Skip inaccessible, removed or malformed files. */ }
    finally { await handle?.close(); }
  }
  async function walk(directory: string, depth = 0): Promise<void> {
    if (depth > 8) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (/\.(ttf|otf|ttc|otc)$/i.test(entry.name)) await readFont(file);
    }
  }
  for (const directory of directories ?? systemFontDirectories(os.platform(), os.homedir(), path.join, process.env)) await walk(directory);
  return fonts.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.path.localeCompare(b.path));
}

export function fontPathExists(file: string): boolean {
  try { return requireNode<typeof import("node:fs")>("fs").statSync(file).isFile(); }
  catch { return false; }
}
