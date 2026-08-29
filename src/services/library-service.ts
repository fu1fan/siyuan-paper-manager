import { ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import { decodeLibraryData, encodeLibraryData } from "../core/codec";
import type { AttributeViewRow, AttributeViewValue, KernelClient } from "../core/kernel";
import { newNodeId } from "../core/node-id";
import type {
  LibraryMetadataField,
  LibraryProject,
  PaperLibraryData,
} from "../types/library";
import {
  DEFAULT_LIBRARY_FIELDS,
  LIBRARY_FIELD_LABELS,
} from "../types/library";
import type { PaperCanonical, PaperData } from "../types/paper";

export interface PaperLibraryInfo {
  docId: string;
  title: string;
  hPath: string;
  notebookId: string;
  data: PaperLibraryData;
}

export interface LibrarySyncResult {
  papers: number;
  restoredRows: number;
  removedRows: number;
  failed: Array<{ docId: string; message: string }>;
}

export class LibraryService {
  constructor(private readonly kernel: KernelClient) {}

  async discoverLibraries(): Promise<PaperLibraryInfo[]> {
    const rows = await this.kernel.listRowsByAttribute(ATTR.libraryData);
    const output: PaperLibraryInfo[] = [];
    for (const row of rows) {
      try {
        output.push({
          docId: String(row.id ?? ""),
          title: String(row.content ?? "文献库"),
          hPath: String(row.hpath ?? ""),
          notebookId: String(row.box ?? ""),
          data: decodeLibraryData(String(row.value ?? "")),
        });
      } catch (error) {
        console.warn("[paper-manager] 跳过损坏的文献库", row.id, error);
      }
    }
    return output;
  }

  async createLibrary(notebookId: string, hPath: string, title: string): Promise<PaperLibraryInfo> {
    const created = await this.kernel.createDocument(notebookId, hPath, `# ${escapeHeading(title)}\n`, title);
    const avId = newNodeId();
    const requestedBlockId = newNodeId();
    const avBlockId = await this.kernel.appendAttributeViewBlock(created.id, requestedBlockId, avId);
    await this.kernel.renderAttributeView(avId, avBlockId, 1, 100, true);
    await this.kernel.setAttributeViewName(avId, `${title} · 文献数据库`);
    const projectKeyId = newNodeId();
    await this.kernel.addAttributeViewKey(avId, projectKeyId, "所属项目", "mSelect");
    const fieldKeyIds: Partial<Record<LibraryMetadataField, string>> = {};
    let previousKeyId = projectKeyId;
    for (const field of DEFAULT_LIBRARY_FIELDS) {
      const keyId = newNodeId();
      await this.kernel.addAttributeViewKey(avId, keyId, LIBRARY_FIELD_LABELS[field], fieldKeyType(field), previousKeyId);
      fieldKeyIds[field] = keyId;
      previousKeyId = keyId;
    }
    const now = new Date().toISOString();
    const data: PaperLibraryData = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      avId,
      avBlockId,
      selectedFields: [...DEFAULT_LIBRARY_FIELDS],
      fieldKeyIds,
      projectKeyId,
      projects: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveLibraryData(created.id, data);
    return { docId: created.id, title, hPath: created.hPath ?? hPath, notebookId, data };
  }

  async getLibrary(docId: string): Promise<PaperLibraryInfo> {
    const attrs = await this.kernel.getBlockAttrs(docId);
    const encoded = attrs[ATTR.libraryData];
    if (!encoded) throw new Error("当前文档不是论文文献库");
    const rows = await this.kernel.query(`SELECT content, hpath, box FROM blocks WHERE id = '${sql(docId)}' LIMIT 1`);
    const row = rows[0] ?? {};
    return {
      docId,
      title: String(row.content ?? "文献库"),
      hPath: String(row.hpath ?? ""),
      notebookId: String(row.box ?? ""),
      data: decodeLibraryData(encoded),
    };
  }

  async updateProjects(libraryDocId: string, projects: LibraryProject[]): Promise<void> {
    const library = await this.getLibrary(libraryDocId);
    const ids = new Set<string>();
    library.data.projects = projects.map((project) => {
      const id = project.id || newNodeId();
      if (ids.has(id)) throw new Error(`项目 ID 重复：${id}`);
      ids.add(id);
      return { id, name: project.name.trim(), docId: project.docId?.trim() || undefined };
    }).filter((project) => project.name);
    library.data.updatedAt = new Date().toISOString();
    await this.saveLibraryData(libraryDocId, library.data);
    await this.syncLibrary(libraryDocId);
  }

  async applySelectedFields(libraryDocId: string, selected: LibraryMetadataField[]): Promise<LibrarySyncResult> {
    const library = await this.getLibrary(libraryDocId);
    const desired = Array.from(new Set(selected));
    let previousKeyId = library.data.projectKeyId;
    for (const field of desired) {
      let keyId = library.data.fieldKeyIds[field];
      if (!keyId) {
        keyId = newNodeId();
        await this.kernel.addAttributeViewKey(
          library.data.avId,
          keyId,
          LIBRARY_FIELD_LABELS[field],
          fieldKeyType(field),
          previousKeyId,
        );
        library.data.fieldKeyIds[field] = keyId;
      }
      previousKeyId = keyId;
    }
    const previous = [...library.data.selectedFields];
    library.data.selectedFields = desired;
    library.data.updatedAt = new Date().toISOString();
    await this.saveLibraryData(libraryDocId, library.data);
    const result = await this.syncLibrary(libraryDocId);
    for (const field of previous) {
      if (desired.includes(field)) continue;
      const keyId = library.data.fieldKeyIds[field];
      if (keyId) await this.kernel.removeAttributeViewKey(library.data.avId, keyId);
      delete library.data.fieldKeyIds[field];
    }
    await this.saveLibraryData(libraryDocId, library.data);
    return result;
  }

  async syncPaper(docId: string, paper?: PaperData): Promise<string> {
    const current = paper ?? await this.kernel.getPaperData(docId);
    if (!current.libraryId) throw new Error("论文尚未归属文献库");
    const library = await this.getLibrary(current.libraryId);
    try {
      let rows = await this.allRows(library.data);
      let row = findBoundRow(rows, docId);
      if (!row) {
        await this.kernel.addAttributeViewBlocks(library.data.avId, library.data.avBlockId, [{
          id: docId,
          content: current.canonical.title,
        }]);
        rows = await retry(() => this.allRows(library.data), (value) => Boolean(findBoundRow(value, docId)));
        row = findBoundRow(rows, docId);
      }
      if (!row) throw new Error("数据库添加论文行后未返回条目 ID");
      for (const field of library.data.selectedFields) {
        const keyId = library.data.fieldKeyIds[field];
        if (keyId) await this.kernel.setAttributeViewCell(
          library.data.avId,
          keyId,
          row.id,
          metadataFieldValue(field, current),
        );
      }
      await this.kernel.setAttributeViewCell(
        library.data.avId,
        library.data.projectKeyId,
        row.id,
        projectFieldValue(current, library.data.projects),
      );
      await this.kernel.setBlockAttrs(docId, {
        [ATTR.libraryItemId]: row.id,
        [ATTR.librarySync]: "ready",
        [ATTR.librarySyncError]: "",
      });
      return row.id;
    } catch (error) {
      await this.kernel.setBlockAttrs(docId, {
        [ATTR.librarySync]: "failed",
        [ATTR.librarySyncError]: message(error).slice(0, 1000),
      });
      throw error;
    }
  }

  async syncLibrary(libraryDocId: string): Promise<LibrarySyncResult> {
    const library = await this.getLibrary(libraryDocId);
    const memberRows = await this.kernel.listRowsByAttribute(ATTR.libraryId, libraryDocId);
    const members = new Map<string, PaperData>();
    const failed: LibrarySyncResult["failed"] = [];
    for (const member of memberRows) {
      const id = String(member.id ?? "");
      if (!id) continue;
      try { members.set(id, await this.kernel.getPaperData(id)); }
      catch (error) { failed.push({ docId: id, message: message(error) }); }
    }
    const rows = await this.allRows(library.data);
    const stale = rows.filter((row) => {
      const bound = boundBlockId(row);
      return bound && !members.has(bound);
    });
    await this.kernel.removeAttributeViewBlocks(library.data.avId, stale.map((row) => row.id));
    let restoredRows = 0;
    for (const [docId, paper] of members) {
      if (!findBoundRow(rows, docId)) restoredRows += 1;
      try { await this.syncPaper(docId, paper); }
      catch (error) { failed.push({ docId, message: message(error) }); }
    }
    return { papers: members.size, restoredRows, removedRows: stale.length, failed };
  }

  async repairLibrary(libraryDocId: string): Promise<LibrarySyncResult> {
    const library = await this.getLibrary(libraryDocId);
    let valid = false;
    try {
      await this.kernel.renderAttributeView(library.data.avId, library.data.avBlockId, 1, 1, false);
      valid = true;
    } catch { /* recreate below */ }
    if (valid) return this.syncLibrary(libraryDocId);
    const avId = newNodeId();
    const avBlockId = await this.kernel.appendAttributeViewBlock(libraryDocId, newNodeId(), avId);
    await this.kernel.renderAttributeView(avId, avBlockId, 1, 100, true);
    await this.kernel.setAttributeViewName(avId, `${library.title} · 文献数据库`);
    const projectKeyId = newNodeId();
    await this.kernel.addAttributeViewKey(avId, projectKeyId, "所属项目", "mSelect");
    library.data.avId = avId;
    library.data.avBlockId = avBlockId;
    library.data.projectKeyId = projectKeyId;
    library.data.fieldKeyIds = {};
    for (const field of library.data.selectedFields) {
      const keyId = newNodeId();
      await this.kernel.addAttributeViewKey(avId, keyId, LIBRARY_FIELD_LABELS[field], fieldKeyType(field));
      library.data.fieldKeyIds[field] = keyId;
    }
    library.data.updatedAt = new Date().toISOString();
    await this.saveLibraryData(libraryDocId, library.data);
    return this.syncLibrary(libraryDocId);
  }

  async citekeys(libraryDocId: string, exceptDocId?: string): Promise<string[]> {
    const rows = await this.kernel.listRowsByAttribute(ATTR.libraryId, libraryDocId);
    const keys: string[] = [];
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id || id === exceptDocId) continue;
      try { keys.push((await this.kernel.getPaperData(id)).citekey); } catch { /* ignored */ }
    }
    return keys;
  }

  private saveLibraryData(docId: string, data: PaperLibraryData): Promise<void> {
    return this.kernel.setBlockAttrs(docId, { [ATTR.libraryData]: encodeLibraryData(data) });
  }

  private async allRows(data: PaperLibraryData): Promise<AttributeViewRow[]> {
    const output: AttributeViewRow[] = [];
    for (let page = 1; page <= 10_000; page += 1) {
      const rendered = await this.kernel.renderAttributeView(data.avId, data.avBlockId, page, 100, false);
      const rows = rendered.view.rows ?? [];
      output.push(...rows);
      if (rows.length < 100 || output.length >= (rendered.view.rowCount ?? 0)) break;
    }
    return output;
  }
}

export function metadataFieldValue(field: LibraryMetadataField, paper: PaperData): AttributeViewValue {
  const c = paper.canonical;
  if (field === "tags") return selectValue(c.tags);
  if (field === "itemType") return selectValue([c.itemType]);
  if (field === "url") return { type: "url", url: { content: c.url ?? "" } };
  return textValue(metadataText(field, c, paper));
}

function metadataText(field: LibraryMetadataField, c: PaperCanonical, paper: PaperData): string {
  switch (field) {
    case "authors": return c.creators.filter((creator) => creator.creatorType === "author").map(creatorName).join("；");
    case "year": return c.date?.match(/\d{4}/)?.[0] ?? c.date ?? "";
    case "journal": return c.journal ?? "";
    case "doi": return c.doi ?? "";
    case "citekey": return paper.citekey;
    case "abstract": return c.abstract ?? "";
    case "publisher": return c.publisher ?? "";
    case "publisherPlace": return c.publisherPlace ?? "";
    case "volume": return c.volume ?? "";
    case "issue": return c.issue ?? "";
    case "pages": return c.pages ?? "";
    case "language": return c.language ?? "";
    case "isbn": return c.isbn ?? "";
    case "issn": return c.issn ?? "";
    case "itemType": return c.itemType;
    case "tags": return c.tags.join("；");
    case "url": return c.url ?? "";
  }
}

function textValue(content: string): AttributeViewValue {
  return { type: "text", text: { content } };
}

function selectValue(contents: string[]): AttributeViewValue {
  return {
    type: contents.length > 1 ? "mSelect" : "select",
    mSelect: contents.filter(Boolean).map((content, index) => ({ content, color: String(index % 14 + 1) })),
  };
}

function projectFieldValue(paper: PaperData, projects: LibraryProject[]): AttributeViewValue {
  const selected = new Set(paper.projectIds);
  return {
    type: "mSelect",
    mSelect: projects.filter((project) => selected.has(project.id)).map((project, index) => ({
      content: project.name,
      color: String(index % 14 + 1),
    })),
  };
}

function fieldKeyType(field: LibraryMetadataField): "text" | "select" | "mSelect" | "url" {
  if (field === "tags") return "mSelect";
  if (field === "itemType") return "select";
  if (field === "url") return "url";
  return "text";
}

function findBoundRow(rows: AttributeViewRow[], docId: string): AttributeViewRow | undefined {
  return rows.find((row) => boundBlockId(row) === docId);
}

function boundBlockId(row: AttributeViewRow): string {
  return row.cells.find((cell) => cell.value.block?.id)?.value.block?.id ?? "";
}

function creatorName(creator: { family: string; given: string }): string {
  return [creator.family, creator.given].filter(Boolean).join(", ");
}

async function retry<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let value = await fn();
  for (let attempt = 0; attempt < 5 && !predicate(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    value = await fn();
  }
  return value;
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/#/g, "\\#");
}

function sql(value: string): string {
  return value.replace(/'/g, "''");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
