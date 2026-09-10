import { ATTR } from "../constants";
import { decodeLibraryData, parseStoredJson } from "../core/codec";
import type { KernelClient } from "../core/kernel";

export interface MembershipDifference {
  kind: "add" | "remove";
  docId: string;
  itemId?: string;
  title: string;
}
export interface MembershipScan {
  libraryId: string;
  title: string;
  avId: string;
  avBlockId: string;
  differences: MembershipDifference[];
}
export const differenceKey = (entry: MembershipDifference): string => `${entry.kind}:${entry.docId}:${entry.itemId ?? ""}`;
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Membership only: never compare or backfill metadata, and never delete notes. */
export class LibraryMembershipService {
  constructor(private readonly kernel: KernelClient) {}

  async scan(libraryId: string, includeIgnored = false): Promise<MembershipScan | null> {
    const attrs = await this.kernel.getBlockAttrs(libraryId);
    if (!attrs[ATTR.libraryData]) return null;
    const data = decodeLibraryData(attrs[ATTR.libraryData]!);
    const roots = await this.kernel.query(`SELECT id, content, path, box FROM blocks WHERE type = 'd' AND id = ${quote(libraryId)} LIMIT 1`);
    const root = roots[0];
    if (!root?.path || !root.box) throw new Error("无法读取文献库目录，已停止成员核对");
    const prefix = `${String(root.path).replace(/\.sy$/, "")}/`;
    const children = new Map<string, string>();
    // Explicit paging avoids the SQL API's default result limit. Only direct children.
    for (let offset = 0; ; offset += 500) {
      const rows = await this.kernel.query(`SELECT id, content FROM blocks WHERE type = 'd' AND box = ${quote(String(root.box))} AND substr(path, 1, ${prefix.length}) = ${quote(prefix)} AND instr(substr(path, ${prefix.length + 1}), '/') = 0 ORDER BY id LIMIT 500 OFFSET ${offset}`);
      for (const row of rows) children.set(String(row.id), String(row.content || row.id));
      if (rows.length < 500) break;
    }
    // A filtered/rendered view is not the database membership truth.
    const definition = await this.kernel.getAttributeView(data.avId);
    const primary = definition.av.keyValues.find(({ key }) => key.type === "block");
    if (!primary || !Array.isArray(primary.values)) throw new Error("无法读取数据库主键成员，已停止成员核对");
    const bound = new Set<string>();
    const differences: MembershipDifference[] = [];
    for (const value of primary.values) {
      const docId = value.isDetached ? "" : value.block?.id ?? "";
      if (!value.blockID) throw new Error("数据库成员缺少条目 ID，已停止成员核对");
      if (docId) bound.add(docId);
      if (!docId || !children.has(docId)) differences.push({ kind: "remove", docId, itemId: value.blockID, title: value.block?.content || docId || "未绑定文档的条目" });
    }
    for (const [docId, title] of children) if (!bound.has(docId)) differences.push({ kind: "add", docId, title });
    const visible: MembershipDifference[] = [];
    const missingIgnores = ignored(attrs[ATTR.membershipIgnored]);
    for (const entry of differences) {
      if (includeIgnored) { visible.push(entry); continue; }
      const token = `${libraryId}:${differenceKey(entry)}`;
      // Missing documents cannot hold attributes: keep their tombstone on the library.
      if (missingIgnores.includes(token)) continue;
      const doc = entry.docId ? await this.kernel.getDocumentInfo(entry.docId) : undefined;
      if (doc && ignored((await this.kernel.getBlockAttrs(entry.docId))[ATTR.membershipIgnored]).includes(token)) continue;
      visible.push(entry);
    }
    return { libraryId, title: String(root.content || libraryId), avId: data.avId, avBlockId: data.avBlockId, differences: visible };
  }

  /** Recheck immediately before each selected action; stale choices never delete new bindings. */
  async resolve(libraryId: string, selected: MembershipDifference[], action: "apply" | "mute"):
    Promise<{ changed: number; skipped: number; failures: string[] }> {
    const result = { changed: 0, skipped: 0, failures: [] as string[] };
    for (const requested of selected) {
      try {
        const scan = await this.scan(libraryId, true);
        if (!scan) throw new Error("该文档已不是文献库");
        const entry = scan.differences.find(value => differenceKey(value) === differenceKey(requested));
        if (!entry) { result.skipped++; continue; }
        const doc = entry.docId ? await this.kernel.getDocumentInfo(entry.docId) : undefined;
        if (action === "mute") {
          const owner = doc ? entry.docId : libraryId;
          const attrs = await this.kernel.getBlockAttrs(owner);
          const tokens = new Set(ignored(attrs[ATTR.membershipIgnored]));
          tokens.add(`${libraryId}:${differenceKey(entry)}`);
          await this.kernel.setBlockAttrs(owner, { [ATTR.membershipIgnored]: JSON.stringify([...tokens]) });
        } else if (entry.kind === "add") {
          await this.kernel.addAttributeViewBlocks(scan.avId, scan.avBlockId, [{ id: entry.docId, content: entry.title }]);
          await this.kernel.setBlockAttrs(entry.docId, { [ATTR.libraryId]: libraryId });
        } else {
          // Clear the old membership hint first so manual repair cannot resurrect
          // a removed out-of-folder row. Never clear another library's ownership.
          if (doc && (await this.kernel.getBlockAttrs(entry.docId))[ATTR.libraryId] === libraryId) {
            await this.kernel.setBlockAttrs(entry.docId, { [ATTR.libraryId]: "", [ATTR.librarySync]: "", [ATTR.librarySyncError]: "" });
          }
          await this.kernel.removeAttributeViewBlocks(scan.avId, [entry.itemId!]);
        }
        result.changed++;
      } catch (error) { result.failures.push(`${requested.title}：${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }
}

function ignored(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = parseStoredJson(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
