import { ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import { decodeLibraryData, encodeLibraryData, encodePaperData } from "../core/codec";
import type { AttributeViewRow, AttributeViewValue, KernelClient } from "../core/kernel";
import { newNodeId } from "../core/node-id";
import type {
  LibraryColumn,
  LibraryMetadataField,
  LibraryProject,
  LibraryDatabaseField,
  PaperLibraryData,
} from "../types/library";
import {
  DEFAULT_LIBRARY_FIELDS,
  LIBRARY_DATABASE_FIELD_LABELS,
  LIBRARY_FIELD_LABELS,
  READING_STATUSES,
  defaultColumnOrder,
  isFixedColumn,
  normalizeColumnOrder,
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

export interface LibraryPaperRecord { docId: string; paper: PaperData; projectIds: string[] }

export class LibraryService {
  private readonly libraryLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly kernel: KernelClient) {}

  /** 串行化同一文献库的结构变更，避免并发初始化重复建列。 */
  private withLibraryLock<T>(docId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.libraryLocks.get(docId) ?? Promise.resolve()).then(task, task);
    this.libraryLocks.set(docId, next.catch(() => undefined));
    return next;
  }

  async discoverLibraries(): Promise<PaperLibraryInfo[]> {
    const rows = await this.kernel.listRowsByAttribute(ATTR.libraryData);
    const output: PaperLibraryInfo[] = [];
    for (const row of rows) {
      try {
        const library: PaperLibraryInfo = {
          docId: String(row.id ?? ""),
          title: String(row.content ?? "文献库"),
          hPath: String(row.hpath ?? ""),
          notebookId: String(row.box ?? ""),
          data: decodeLibraryData(String(row.value ?? "")),
        };
        try { await this.ensureDatabaseFields(library); }
        catch (error) { console.warn("[paper-manager] 阅读字段初始化失败，可在设置中重试修复", library.docId, error); }
        output.push(library);
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
    await this.setAttributeViewNameSafely(avId, `${title} · 文献数据库`);
    const projectKeyId = newNodeId();
    await this.kernel.addAttributeViewKey(avId, projectKeyId, "所属项目", "mSelect");
    const databaseKeyIds: Partial<Record<LibraryDatabaseField, string>> = {};
    let previousKeyId = projectKeyId;
    for (const field of databaseFields()) {
      const keyId = newNodeId();
      await this.kernel.addAttributeViewKey(
        avId, keyId, LIBRARY_DATABASE_FIELD_LABELS[field], databaseFieldKeyType(field), previousKeyId,
      );
      await this.configureDatabaseFieldOptions(avId, keyId, field);
      databaseKeyIds[field] = keyId;
      previousKeyId = keyId;
    }
    const fieldKeyIds: Partial<Record<LibraryMetadataField, string>> = {};
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
      databaseKeyIds,
      columnOrder: defaultColumnOrder(),
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
    const library: PaperLibraryInfo = {
      docId,
      title: String(row.content ?? "文献库"),
      hPath: String(row.hpath ?? ""),
      notebookId: String(row.box ?? ""),
      data: decodeLibraryData(encoded),
    };
    if (databaseFields().some((field) => !library.data.databaseKeyIds[field])) {
      await this.ensureDatabaseFields(library);
    }
    return library;
  }

  async updateProjects(libraryDocId: string, projects: LibraryProject[]): Promise<void> {
    const library = await this.getLibrary(libraryDocId);
    const previousProjects = new Map(library.data.projects.map((project) => [project.name, project.id]));
    const ids = new Set<string>();
    const names = new Set<string>();
    const nextProjects = projects.map((project) => {
      const id = project.id || newNodeId();
      if (ids.has(id)) throw new Error(`项目 ID 重复：${id}`);
      ids.add(id);
      const name = project.name.trim();
      if (name && names.has(name)) throw new Error(`项目名称重复：${name}`);
      if (name) names.add(name);
      return { id, name, docId: project.docId?.trim() || undefined };
    }).filter((project) => project.name);
    const nextById = new Map(nextProjects.map((project) => [project.id, project]));
    const rows = await this.allRows(library.data);
    library.data.projects = nextProjects;
    library.data.updatedAt = new Date().toISOString();
    await this.saveLibraryData(libraryDocId, library.data);
    for (const row of rows) {
      const names = selectContents(row, library.data.projectKeyId);
      const renamed = names.map((name) => {
        const id = previousProjects.get(name);
        return id ? nextById.get(id)?.name ?? name : name;
      });
      if (renamed.some((name, index) => name !== names[index])) {
        await this.kernel.setAttributeViewCell(
          library.data.avId, library.data.projectKeyId, row.id, selectValue(renamed, "mSelect"),
        );
      }
    }
  }

  async applySelectedFields(
    libraryDocId: string,
    selected: LibraryMetadataField[],
    columnOrder?: LibraryColumn[],
  ): Promise<LibrarySyncResult> {
    const library = await this.getLibrary(libraryDocId);
    const desired = Array.from(new Set(selected));
    library.data.columnOrder = normalizeColumnOrder(columnOrder ?? library.data.columnOrder);
    let previousKeyId = library.data.databaseKeyIds.rating ?? library.data.projectKeyId;
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
    await this.reorderManagedFields(library);
    return result;
  }

  /** 仅调整数据库列顺序：不增删字段、不重建论文行。 */
  async applyColumnOrder(libraryDocId: string, columnOrder: LibraryColumn[]): Promise<void> {
    const library = await this.getLibrary(libraryDocId);
    library.data.columnOrder = normalizeColumnOrder(columnOrder);
    library.data.updatedAt = new Date().toISOString();
    await this.saveLibraryData(libraryDocId, library.data);
    await this.reorderManagedFields(library);
  }

  async syncPaper(docId: string, paper?: PaperData): Promise<string> {
    const current = paper ?? await this.kernel.getPaperData(docId);
    if (!current.libraryId) throw new Error("论文尚未归属文献库");
    const library = await this.getLibrary(current.libraryId);
    try {
      let rows = await this.allRows(library.data);
      let row = findBoundRow(rows, docId);
      const createdRow = !row;
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
      if (createdRow) {
        const statusKeyId = library.data.databaseKeyIds.readingStatus;
        const ratingKeyId = library.data.databaseKeyIds.rating;
        if (statusKeyId) await this.kernel.setAttributeViewCell(
          library.data.avId, statusKeyId, row.id, selectValue([READING_STATUSES[0]], "select"),
        );
        if (ratingKeyId) await this.kernel.setAttributeViewCell(
          library.data.avId, ratingKeyId, row.id, selectValue(["0"], "select"),
        );
      }
      if (current.legacyProjectIds?.length && !selectContents(row, library.data.projectKeyId).length) {
        await this.kernel.setAttributeViewCell(
          library.data.avId,
          library.data.projectKeyId,
          row.id,
          projectFieldValue(current.legacyProjectIds, library.data.projects),
        );
      }
      const syncAttrs: Record<string, string> = {
        [ATTR.libraryItemId]: row.id,
        [ATTR.librarySync]: "ready",
        [ATTR.librarySyncError]: "",
      };
      if (current.legacyProjectIds) syncAttrs[ATTR.data] = encodePaperData(current);
      await this.kernel.setBlockAttrs(docId, syncAttrs);
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
    await this.setAttributeViewNameSafely(avId, `${library.title} · 文献数据库`);
    const projectKeyId = newNodeId();
    await this.kernel.addAttributeViewKey(avId, projectKeyId, "所属项目", "mSelect");
    library.data.avId = avId;
    library.data.avBlockId = avBlockId;
    library.data.projectKeyId = projectKeyId;
    library.data.databaseKeyIds = {};
    let previousKeyId = projectKeyId;
    for (const field of databaseFields()) {
      const keyId = newNodeId();
      await this.kernel.addAttributeViewKey(
        avId, keyId, LIBRARY_DATABASE_FIELD_LABELS[field], databaseFieldKeyType(field), previousKeyId,
      );
      await this.configureDatabaseFieldOptions(avId, keyId, field);
      library.data.databaseKeyIds[field] = keyId;
      previousKeyId = keyId;
    }
    library.data.fieldKeyIds = {};
    for (const field of library.data.selectedFields) {
      const keyId = newNodeId();
      await this.kernel.addAttributeViewKey(avId, keyId, LIBRARY_FIELD_LABELS[field], fieldKeyType(field), previousKeyId);
      library.data.fieldKeyIds[field] = keyId;
      previousKeyId = keyId;
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

  async listPapers(libraryDocId: string): Promise<LibraryPaperRecord[]> {
    const library = await this.getLibrary(libraryDocId);
    const rows = await this.kernel.listRowsByAttribute(ATTR.libraryId, libraryDocId);
    const avRows = await this.allRows(library.data);
    const avRowsByDoc = new Map(avRows.map((row) => [boundBlockId(row), row]));
    const projectIdsByName = new Map(library.data.projects.map((project) => [project.name, project.id]));
    const output: LibraryPaperRecord[] = [];
    for (const row of rows) {
      const docId = String(row.id ?? "");
      if (!docId) continue;
      try {
        const projectIds = selectContents(avRowsByDoc.get(docId), library.data.projectKeyId)
          .map((name) => projectIdsByName.get(name)).filter((id): id is string => Boolean(id));
        output.push({ docId, paper: await this.kernel.getPaperData(docId), projectIds });
      }
      catch (error) { console.warn("[paper-manager] 导出时跳过损坏的论文页", docId, error); }
    }
    return output.sort((left, right) => left.paper.importedAt.localeCompare(right.paper.importedAt));
  }

  private saveLibraryData(docId: string, data: PaperLibraryData): Promise<void> {
    return this.kernel.setBlockAttrs(docId, { [ATTR.libraryData]: encodeLibraryData(data) });
  }

  private async ensureDatabaseFields(library: PaperLibraryInfo): Promise<void> {
    await this.withLibraryLock(library.docId, async () => {
      // 以数据库实际列为准对齐：同名已有列直接复用，同名重复列删除，
      // 避免旧数据、并发调用或中途失败导致的重复建列。
      const definition = await this.kernel.getAttributeView(library.data.avId);
      const keysByName = new Map<string, string[]>();
      for (const entry of definition.av.keyValues) {
        const list = keysByName.get(entry.key.name) ?? [];
        list.push(entry.key.id);
        keysByName.set(entry.key.name, list);
      }
      let changed = false;
      let previousKeyId = library.data.projectKeyId;
      for (const field of databaseFields()) {
        const label = LIBRARY_DATABASE_FIELD_LABELS[field];
        const matches = keysByName.get(label) ?? [];
        const recorded = library.data.databaseKeyIds[field];
        let keyId = recorded && matches.includes(recorded) ? recorded : matches[0];
        for (const duplicate of matches.filter((id) => id !== keyId)) {
          await this.kernel.removeAttributeViewKey(library.data.avId, duplicate);
          changed = true;
        }
        if (!keyId) {
          keyId = newNodeId();
          await this.kernel.addAttributeViewKey(
            library.data.avId, keyId, label, databaseFieldKeyType(field), previousKeyId,
          );
          changed = true;
        }
        await this.configureDatabaseFieldOptions(library.data.avId, keyId, field);
        if (library.data.databaseKeyIds[field] !== keyId) {
          library.data.databaseKeyIds[field] = keyId;
          changed = true;
        }
        previousKeyId = keyId;
      }
      if (!changed) return;
      library.data.updatedAt = new Date().toISOString();
      await this.saveLibraryData(library.docId, library.data);
      await this.reorderManagedFields(library);
    });
  }

  private async reorderManagedFields(library: PaperLibraryInfo): Promise<void> {
    const definition = await this.kernel.getAttributeView(library.data.avId);
    const blockKeyId = definition.av.keyValues.find((entry) => entry.key.type === "block")?.key.id ?? "";
    const keyIds = library.data.columnOrder
      .map((column) => columnKeyId(library.data, column))
      .filter((id): id is string => Boolean(id));
    // 主表 keyIDs 顺序决定新建视图的默认列序
    let previousKeyId = blockKeyId;
    for (const keyId of keyIds) {
      await this.kernel.sortAttributeViewKey(library.data.avId, keyId, previousKeyId);
      previousKeyId = keyId;
    }
    // 已有视图的表头顺序由各自的 columns 决定，需要逐视图排序
    for (const view of definition.av.views ?? []) {
      let previous = blockKeyId;
      for (const keyId of keyIds) {
        await this.kernel.sortAttributeViewViewKey(library.data.avId, view.id, keyId, previous);
        previous = keyId;
      }
    }
  }

  private async configureDatabaseFieldOptions(
    avId: string,
    keyId: string,
    field: LibraryDatabaseField,
  ): Promise<void> {
    try {
      if (field === "readingStatus") {
        await this.kernel.setAttributeViewSelectOptions(avId, keyId, [...READING_STATUSES]);
      } else if (field === "rating") {
        await this.kernel.setAttributeViewSelectOptions(avId, keyId, ["0", "1", "2", "3", "4", "5"]);
      }
    } catch (error) {
      console.warn("[paper-manager] 数据库选项预设失败，可在思源中手动添加选项", field, error);
    }
  }

  private async setAttributeViewNameSafely(avId: string, name: string): Promise<void> {
    try {
      await this.kernel.setAttributeViewName(avId, name);
    } catch (error) {
      // The database name is cosmetic. Older kernels have changed the raw
      // transaction contract, so a naming failure must not abort library setup.
      console.warn("[paper-manager] 数据库重命名失败，继续创建文献库", error);
    }
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
  if (field === "tags") return selectValue(c.tags, "mSelect");
  if (field === "itemType") return selectValue([c.itemType], "select");
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

function selectValue(contents: string[], type: "select" | "mSelect"): AttributeViewValue {
  return {
    type,
    mSelect: contents.filter(Boolean).map((content, index) => ({ content, color: String(index % 14 + 1) })),
  };
}

function projectFieldValue(projectIds: string[], projects: LibraryProject[]): AttributeViewValue {
  const selected = new Set(projectIds);
  return {
    type: "mSelect",
    mSelect: projects.filter((project) => selected.has(project.id)).map((project, index) => ({
      content: project.name,
      color: String(index % 14 + 1),
    })),
  };
}

function selectContents(row: AttributeViewRow | undefined, keyId: string): string[] {
  if (!row) return [];
  return row.cells.find((cell) => cell.value.keyID === keyId)?.value.mSelect
    ?.map((item) => item.content).filter(Boolean) ?? [];
}

function databaseFields(): LibraryDatabaseField[] {
  return ["addedAt", "readingStatus", "rating"];
}

function columnKeyId(data: PaperLibraryData, column: LibraryColumn): string | undefined {
  if (column === "project") return data.projectKeyId;
  if (isFixedColumn(column)) return data.databaseKeyIds[column];
  return data.fieldKeyIds[column];
}

function databaseFieldKeyType(field: LibraryDatabaseField): "created" | "select" {
  if (field === "addedAt") return "created";
  return "select";
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
