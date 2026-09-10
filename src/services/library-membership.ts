import { ATTR } from "../constants";
import { decodeLibraryData, paperStateAttrs, parseStoredJson } from "../core/codec";
import type { AttributeViewDefinition, AttributeViewRow, KernelClient } from "../core/kernel";
import { retryUntil } from "../core/retry";
import { newNodeId } from "../core/node-id";
import { sanitizeDocumentName } from "../core/naming";
import { TemplateService } from "../core/templates";
import { paperFromRow, type PaperLibraryInfo } from "./library-service";

export interface MembershipDifference {
  kind: "delete-note" | "create-note" | "outside-note";
  docId: string;
  itemId?: string;
  title: string;
  outsideAction?: "move" | "copy";
  descendantIds?: string[];
  blockedReason?: string;
  pending?: boolean;
}
export interface MembershipScan {
  libraryId: string;
  title: string;
  avId: string;
  avBlockId: string;
  differences: MembershipDifference[];
}
interface Doc { id: string; title: string; path: string; box: string; hPath: string }
interface Pending { docId: string; sourceId: string; kind: "create-note" | "outside-note"; title: string }
interface Snapshot {
  library: PaperLibraryInfo; root: Doc; docs: Doc[];
  rows: AttributeViewRow[]; pending: Record<string, Pending>; attrs: Record<string, string>;
}
export const differenceKey = (entry: MembershipDifference): string => `v2:${entry.kind}:${entry.docId}:${entry.itemId ?? ""}`;
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const prefix = (path: string): string => `${path.replace(/\.sy$/, "")}/`;
const boundId = (row: AttributeViewRow): string => {
  const value = row.cells.find(cell => cell.value.type === "block")?.value;
  return value?.isDetached ? "" : value?.block?.id ?? "";
};

/** Database rows are authoritative. Never add/remove rows or write metadata cells. */
export class LibraryMembershipService {
  constructor(private readonly kernel: KernelClient, private readonly templates = new TemplateService(kernel)) {}

  private async document(id: string): Promise<Doc | undefined> {
    if (!id) return undefined;
    const rows = await this.kernel.query(`SELECT id, content, path, box, hpath FROM blocks WHERE type = 'd' AND id = ${quote(id)} LIMIT 1`);
    return rows[0] ? toDoc(rows[0]) : undefined;
  }

  private async snapshot(libraryId: string): Promise<Snapshot | null> {
    const attrs = await this.kernel.getBlockAttrs(libraryId);
    if (!attrs[ATTR.libraryData]) return null;
    const data = decodeLibraryData(attrs[ATTR.libraryData]!);
    const root = await this.document(libraryId);
    if (!root?.path || !root.box) throw new Error("无法读取文献库目录，已停止成员核对");
    const docs: Doc[] = [];
    const dir = prefix(root.path);
    for (let offset = 0; ; offset += 500) {
      const rows = await this.kernel.query(`SELECT id, content, path, box, hpath FROM blocks WHERE type = 'd' AND box = ${quote(root.box)} AND substr(path, 1, ${dir.length}) = ${quote(dir)} ORDER BY id LIMIT 500 OFFSET ${offset}`);
      docs.push(...rows.map(toDoc));
      if (rows.length < 500) break;
    }
    const definition = await this.kernel.getAttributeView(data.avId);
    return { root, docs, attrs, pending: readPending(attrs[ATTR.membershipPending]), rows: databaseRows(definition),
      library: { docId: libraryId, title: root.title, notebookId: root.box, hPath: root.hPath, data } };
  }

  async scan(libraryId: string, includeIgnored = false): Promise<MembershipScan | null> {
    const snapshot = await this.snapshot(libraryId);
    if (!snapshot) return null;
    const { root, docs, rows, pending, attrs, library } = snapshot;
    const direct = new Set(docs.filter(doc => !doc.path.slice(prefix(root.path).length).includes("/")).map(doc => doc.id));
    const bound = new Set(rows.map(boundId).filter(Boolean));
    const reserved = new Set(Object.values(pending).map(value => value.docId));
    const differences: MembershipDifference[] = [];
    for (const row of rows) {
      const job = pending[row.id];
      const docId = boundId(row);
      if (job) {
        differences.push({ kind: job.kind, docId: job.sourceId, itemId: row.id, title: job.title,
          outsideAction: job.kind === "outside-note" ? "copy" : undefined, pending: true });
      } else if (!direct.has(docId)) {
        const doc = await this.document(docId);
        differences.push({ kind: doc ? "outside-note" : "create-note", docId, itemId: row.id,
          title: paperFromRow(library, row, docId).canonical.title || doc?.title || "未命名条目",
          outsideAction: doc ? "move" : undefined,
          blockedReason: doc && doc.box === root.box && root.path.startsWith(prefix(doc.path)) ? "该笔记是文献库的祖先，不能移回；请选择新建副本。" : undefined });
      }
    }
    for (const doc of docs.filter(value => direct.has(value.id) && !bound.has(value.id) && !reserved.has(value.id))) {
      const descendants = docs.filter(value => value.path.startsWith(prefix(doc.path)));
      differences.push({ kind: "delete-note", docId: doc.id, title: doc.title,
        descendantIds: descendants.map(value => value.id).sort(),
        blockedReason: descendants.some(value => bound.has(value.id) || reserved.has(value.id))
          ? "下级笔记包含数据库成员或待恢复笔记，请先处理这些笔记再删除。" : undefined });
    }
    const visible: MembershipDifference[] = [];
    for (const entry of differences) {
      if (includeIgnored) { visible.push(entry); continue; }
      const token = `${libraryId}:${differenceKey(entry)}`;
      if (ignored(attrs[ATTR.membershipIgnored]).includes(token)) continue;
      const doc = await this.document(entry.docId);
      if (doc && ignored((await this.kernel.getBlockAttrs(doc.id))[ATTR.membershipIgnored]).includes(token)) continue;
      visible.push(entry);
    }
    return { libraryId, title: root.title, avId: library.data.avId, avBlockId: library.data.avBlockId, differences: visible };
  }

  async resolve(libraryId: string, selected: MembershipDifference[], action: "apply" | "mute"):
    Promise<{ changed: number; skipped: number; failures: string[] }> {
    const result = { changed: 0, skipped: 0, failures: [] as string[] };
    for (const requested of selected) {
      try {
        const scan = await this.scan(libraryId, true);
        if (!scan) throw new Error("该文档已不是文献库");
        const entry = scan.differences.find(value => differenceKey(value) === differenceKey(requested));
        if (!entry) { result.skipped++; continue; }
        if (action === "mute") {
          const owner = await this.document(entry.docId) ? entry.docId : libraryId;
          const attrs = await this.kernel.getBlockAttrs(owner);
          const tokens = new Set(ignored(attrs[ATTR.membershipIgnored]));
          tokens.add(`${libraryId}:${differenceKey(entry)}`);
          await this.kernel.setBlockAttrs(owner, { [ATTR.membershipIgnored]: JSON.stringify([...tokens]) });
        } else if (entry.kind === "delete-note") {
          if (entry.blockedReason) throw new Error(entry.blockedReason);
          if (JSON.stringify(entry.descendantIds) !== JSON.stringify(requested.descendantIds)) {
            throw new Error("下级笔记范围已变化，请重新核对后勾选删除");
          }
          const doc = await this.document(entry.docId);
          if (!doc) { result.skipped++; continue; }
          await this.kernel.removeDocument(doc.box, doc.path);
          await retryUntil(() => this.document(doc.id), value => !value, 20, 150);
        } else if (entry.kind === "outside-note" && !entry.pending && requested.outsideAction !== "copy") {
          if (entry.blockedReason) throw new Error(entry.blockedReason);
          await this.kernel.moveDocument(entry.docId, libraryId);
          await retryUntil(() => this.kernel.parentDocumentId(entry.docId), value => value === libraryId, 20, 150);
        } else {
          await this.createAndBind(libraryId, entry);
        }
        result.changed++;
      } catch (error) { result.failures.push(`${requested.title}：${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }

  private async createAndBind(libraryId: string, entry: MembershipDifference): Promise<void> {
    const snapshot = await this.snapshot(libraryId);
    if (!snapshot) throw new Error("文献库已不存在");
    const { library, rows, pending } = snapshot;
    const row = rows.find(value => value.id === entry.itemId);
    if (!row) throw new Error("原数据库条目已不存在");
    let job = pending[row.id];
    if (!job) {
      if (boundId(row) !== entry.docId) throw new Error("条目绑定已变化，请重新核对");
      job = { docId: newNodeId(), sourceId: entry.docId, kind: entry.kind as Pending["kind"], title: entry.title };
      pending[row.id] = job;
      await this.savePending(libraryId, pending);
    }
    if (boundId(row) !== job.sourceId && boundId(row) !== job.docId) throw new Error("原条目已被换绑，保留待恢复笔记，请手动核对");
    const paper = paperFromRow(library, row, job.docId);
    const name = sanitizeDocumentName(paper.citekey || paper.canonical.title || "未命名文献");
    let doc = await this.document(job.docId);
    if (!doc) {
      // Preallocated ID and unique temporary name make ambiguous create failures retryable.
      const created = await this.kernel.createDocument(library.notebookId,
        `${library.hPath}/${name}-${job.docId}`, `# ${paper.canonical.title.replace(/[\r\n]/g, " ") || name}\n`, name,
        { id: job.docId, parentID: libraryId });
      if (created.id !== job.docId) throw new Error("创建文档 ID 与恢复记录不符，已停止换绑");
      doc = await retryUntil(() => this.document(job.docId), Boolean, 20, 150);
      if (!doc) throw new Error("新笔记索引尚未就绪，请重试");
    }
    if (await this.kernel.parentDocumentId(doc.id) !== libraryId) throw new Error("待恢复笔记已被移出文献库，请移回后重试");
    // Preserve any later user attachments: initialize machine state only on first preparation.
    const attrs = await this.kernel.getBlockAttrs(doc.id);
    if (!attrs[ATTR.libraryId]) await this.kernel.setBlockAttrs(doc.id, paperStateAttrs(paper));
    const sections = await this.templates.ensureSections(doc.id, paper);
    await this.templates.refreshMeta(doc.id, paper, sections.meta);
    await this.kernel.renameDocument(doc.id, name);
    const fresh = databaseRows(await this.kernel.getAttributeView(library.data.avId));
    const target = fresh.find(value => value.id === row.id);
    if (!target || (boundId(target) !== job.sourceId && boundId(target) !== job.docId)) throw new Error("原条目绑定已变化，未执行换绑");
    if (fresh.some(value => value.id !== row.id && boundId(value) === doc.id)) throw new Error("新笔记已绑定其他条目，已停止换绑");
    if (boundId(target) !== doc.id) await this.kernel.rebindAttributeViewRow(library.data.avId, library.data.avBlockId, row.id, doc.id);
    const verified = await retryUntil(async () => databaseRows(await this.kernel.getAttributeView(library.data.avId)),
      values => boundId(values.find(value => value.id === row.id) ?? { id: "", cells: [] }) === doc.id, 20, 150);
    if (boundId(verified.find(value => value.id === row.id) ?? { id: "", cells: [] }) !== doc.id) throw new Error("换绑结果尚未确认，请重试");
    delete pending[row.id];
    await this.savePending(libraryId, pending);
  }

  private async savePending(libraryId: string, pending: Record<string, Pending>): Promise<void> {
    await this.kernel.setBlockAttrs(libraryId, { [ATTR.membershipPending]: JSON.stringify(pending) });
  }
}

function toDoc(row: Record<string, unknown>): Doc {
  return { id: String(row.id), title: String(row.content || row.id), path: String(row.path || ""), box: String(row.box || ""), hPath: String(row.hpath || "") };
}
function databaseRows(definition: AttributeViewDefinition): AttributeViewRow[] {
  const primary = definition.av.keyValues.find(({ key }) => key.type === "block");
  if (!primary || !Array.isArray(primary.values)) throw new Error("无法读取数据库主键成员，已停止成员核对");
  return primary.values.map(value => {
    if (!value.blockID) throw new Error("数据库成员缺少条目 ID，已停止成员核对");
    return { id: value.blockID, cells: definition.av.keyValues.flatMap(({ key, values }) =>
      (values ?? []).filter(cell => cell.blockID === value.blockID).map(cell => ({ value: { ...cell, type: key.type, keyID: key.id } }))) };
  });
}
function ignored(value?: string): string[] {
  if (!value) return [];
  try { const parsed: unknown = parseStoredJson(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}
function readPending(value?: string): Record<string, Pending> {
  if (!value) return {};
  const parsed = parseStoredJson(value) as Record<string, Pending>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some(job => !job || typeof job.docId !== "string" || typeof job.sourceId !== "string" || !["create-note", "outside-note"].includes(job.kind))) {
    throw new Error("成员恢复记录损坏，已停止核对以保护待恢复笔记");
  }
  return parsed;
}
