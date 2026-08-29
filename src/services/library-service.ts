import { ATTR, LEGACY_ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import { decodeLegacyPaperData, decodeLibraryData, encodeLibraryData } from "../core/codec";
import type { AttributeViewRow, AttributeViewValue, KernelClient } from "../core/kernel";
import { newNodeId } from "../core/node-id";
import type {
  LibraryDatabaseField,
  LibraryMetadataField,
  LibraryProject,
  PaperLibraryData,
} from "../types/library";
import {
  LIBRARY_DATABASE_FIELD_LABELS,
  LIBRARY_FIELD_LABELS,
  LIBRARY_METADATA_FIELDS,
  READING_STATUSES,
} from "../types/library";
import type { PaperCanonical, PaperCreator, PaperData } from "../types/paper";

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

export interface PaperEntry {
  library: PaperLibraryInfo;
  itemId: string;
  row: AttributeViewRow;
}

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
        try { await this.ensureSchemaFields(library); }
        catch (error) { console.warn("[paper-manager] 数据库字段初始化失败，可在设置中重试修复", library.docId, error); }
        try { await this.migrateLegacyPapers(library); }
        catch (error) { console.warn("[paper-manager] 旧版论文数据迁移失败", library.docId, error); }
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
    for (const field of LIBRARY_METADATA_FIELDS) {
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
      fieldKeyIds,
      projectKeyId,
      databaseKeyIds,
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
    if (
      databaseFields().some((field) => !library.data.databaseKeyIds[field])
      || LIBRARY_METADATA_FIELDS.some((field) => !library.data.fieldKeyIds[field])
    ) {
      await this.ensureSchemaFields(library);
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

  /**
   * 判断文档是否为论文页：父文档是文献库，且父文档数据库中存在
   * 绑定到该文档的条目（块 ↔ 条目的直接关联）。
   */
  async findPaperEntry(docId: string): Promise<PaperEntry | null> {
    const parentId = await this.kernel.parentDocumentId(docId);
    if (!parentId) return null;
    let library: PaperLibraryInfo;
    try {
      library = await this.getLibrary(parentId);
    } catch {
      return null;
    }
    const itemId = await this.findItemId(library.data, docId);
    if (!itemId) return null;
    const row = (await this.allRows(library.data)).find((candidate) => candidate.id === itemId);
    if (!row) return null;
    return { library, itemId, row };
  }

  /** 从数据库行重建论文数据；附件与翻译产物等机器状态读文档属性。 */
  async readPaper(docId: string): Promise<PaperData> {
    const entry = await this.findPaperEntry(docId);
    if (!entry) throw new Error("当前文档不是论文页：父页数据库中没有对应条目");
    const attrs = await this.kernel.getBlockAttrs(docId);
    return paperFromRow(entry.library, entry.row, docId, attrs);
  }

  /**
   * 导入/合并时同步论文行：建行（如缺失）、写入元数据列、初始化阅读字段。
   * writeMetadata 为 false 时只确保行存在，不回写元数据列——数据库是
   * 元数据权威，修复与翻译后刷新不得覆盖用户在数据库中的编辑。
   */
  async syncPaper(docId: string, paper: PaperData, writeMetadata = false): Promise<string> {
    if (!paper.libraryId) throw new Error("论文尚未归属文献库");
    const library = await this.getLibrary(paper.libraryId);
    try {
      let rows = await this.allRows(library.data);
      let row = findBoundRow(rows, docId);
      const createdRow = !row;
      if (!row) {
        await this.kernel.addAttributeViewBlocks(library.data.avId, library.data.avBlockId, [{
          id: docId,
          content: paper.canonical.title,
        }]);
        rows = await retry(() => this.allRows(library.data), (value) => Boolean(findBoundRow(value, docId)));
        row = findBoundRow(rows, docId);
      }
      if (!row) throw new Error("数据库添加论文行后未返回条目 ID");
      if (writeMetadata) {
        for (const field of LIBRARY_METADATA_FIELDS) {
          const keyId = library.data.fieldKeyIds[field];
          if (keyId) await this.kernel.setAttributeViewCell(
            library.data.avId,
            keyId,
            row.id,
            metadataFieldValue(field, paper),
          );
        }
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
      await this.kernel.setBlockAttrs(docId, {
        [ATTR.libraryId]: paper.libraryId,
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
    const members = new Map<string, string>();
    for (const member of memberRows) {
      const id = String(member.id ?? "");
      if (id) members.set(id, String(member.content ?? ""));
    }
    const rows = await this.allRows(library.data);
    const stale = rows.filter((row) => {
      const bound = boundBlockId(row);
      return bound && !members.has(bound);
    });
    await this.kernel.removeAttributeViewBlocks(library.data.avId, stale.map((row) => row.id));
    let restoredRows = 0;
    const failed: LibrarySyncResult["failed"] = [];
    for (const [docId, content] of members) {
      if (findBoundRow(rows, docId)) continue;
      try {
        await this.kernel.addAttributeViewBlocks(library.data.avId, library.data.avBlockId, [{ id: docId, content }]);
        restoredRows += 1;
      } catch (error) { failed.push({ docId, message: message(error) }); }
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
    // 数据库文件损坏时重建：列结构可恢复，行由成员文档补回，
    // 但原有单元格内容随损坏的数据库一并丢失，无法找回。
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
    for (const field of LIBRARY_METADATA_FIELDS) {
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
    const library = await this.getLibrary(libraryDocId);
    const keyId = library.data.fieldKeyIds.citekey;
    if (!keyId) return [];
    const rows = await this.allRows(library.data);
    const keys: string[] = [];
    for (const row of rows) {
      const docId = boundBlockId(row);
      if (!docId || docId === exceptDocId) continue;
      const value = row.cells.find((cell) => cell.value.keyID === keyId)?.value.text?.content?.trim();
      if (value) keys.push(value);
    }
    return keys;
  }

  async listPapers(libraryDocId: string): Promise<LibraryPaperRecord[]> {
    const library = await this.getLibrary(libraryDocId);
    const rows = await this.allRows(library.data);
    const projectIdsByName = new Map(library.data.projects.map((project) => [project.name, project.id]));
    const output: LibraryPaperRecord[] = [];
    for (const row of rows) {
      const docId = boundBlockId(row);
      if (!docId) continue;
      const projectIds = selectContents(row, library.data.projectKeyId)
        .map((name) => projectIdsByName.get(name)).filter((id): id is string => Boolean(id));
      output.push({ docId, paper: paperFromRow(library, row, docId), projectIds });
    }
    return output;
  }

  private saveLibraryData(docId: string, data: PaperLibraryData): Promise<void> {
    return this.kernel.setBlockAttrs(docId, { [ATTR.libraryData]: encodeLibraryData(data) });
  }

  /**
   * 以数据库实际列为准对齐全部管理列（阅读字段 + 全部元数据字段）：
   * 同名已有列直接复用，同名重复列删除，缺失才建。
   */
  private async ensureSchemaFields(library: PaperLibraryInfo): Promise<void> {
    await this.withLibraryLock(library.docId, async () => {
      const definition = await this.kernel.getAttributeView(library.data.avId);
      const keysByName = new Map<string, string[]>();
      for (const entry of definition.av.keyValues) {
        const list = keysByName.get(entry.key.name) ?? [];
        list.push(entry.key.id);
        keysByName.set(entry.key.name, list);
      }
      let changed = false;
      let previousKeyId = library.data.projectKeyId;
      const align = async (
        label: string,
        type: AttributeViewKeyTypeLike,
        recorded: string | undefined,
      ): Promise<string> => {
        const matches = keysByName.get(label) ?? [];
        let keyId = recorded && matches.includes(recorded) ? recorded : matches[0];
        for (const duplicate of matches.filter((id) => id !== keyId)) {
          await this.kernel.removeAttributeViewKey(library.data.avId, duplicate);
          changed = true;
        }
        if (!keyId) {
          keyId = newNodeId();
          await this.kernel.addAttributeViewKey(library.data.avId, keyId, label, type, previousKeyId);
          changed = true;
        }
        previousKeyId = keyId;
        return keyId;
      };
      for (const field of databaseFields()) {
        const keyId = await align(LIBRARY_DATABASE_FIELD_LABELS[field], databaseFieldKeyType(field), library.data.databaseKeyIds[field]);
        await this.configureDatabaseFieldOptions(library.data.avId, keyId, field);
        if (library.data.databaseKeyIds[field] !== keyId) {
          library.data.databaseKeyIds[field] = keyId;
          changed = true;
        }
      }
      for (const field of LIBRARY_METADATA_FIELDS) {
        const keyId = await align(LIBRARY_FIELD_LABELS[field], fieldKeyType(field), library.data.fieldKeyIds[field]);
        if (library.data.fieldKeyIds[field] !== keyId) {
          library.data.fieldKeyIds[field] = keyId;
          changed = true;
        }
      }
      if (!changed) return;
      library.data.updatedAt = new Date().toISOString();
      await this.saveLibraryData(library.docId, library.data);
    });
  }

  /**
   * 一次性迁移：把仍带旧版 base64 数据的论文文档搬进数据库。
   * 只回填空单元格——用户在数据库中的手动编辑优先；完成后清除全部
   * 旧版属性，此后 legacy 解码不再被触发。
   */
  private async migrateLegacyPapers(library: PaperLibraryInfo): Promise<void> {
    const legacyRows = await this.kernel.listRowsByAttribute(LEGACY_ATTR.data);
    const candidates = legacyRows
      .map((row) => ({ docId: String(row.id ?? ""), encoded: String(row.value ?? "") }))
      .filter((candidate) => candidate.docId && candidate.encoded);
    if (!candidates.length) return;
    await this.withLibraryLock(library.docId, async () => {
      let rows = await this.allRows(library.data);
      for (const candidate of candidates) {
        let legacy;
        try {
          legacy = decodeLegacyPaperData(candidate.encoded);
        } catch (error) {
          console.warn("[paper-manager] 跳过无法解码的旧版论文数据", candidate.docId, error);
          continue;
        }
        if (legacy.libraryId && legacy.libraryId !== library.docId) continue;
        try {
          let row = findBoundRow(rows, candidate.docId);
          if (!row) {
            await this.kernel.addAttributeViewBlocks(library.data.avId, library.data.avBlockId, [{
              id: candidate.docId,
              content: legacy.canonical.title,
            }]);
            rows = await retry(() => this.allRows(library.data), (value) => Boolean(findBoundRow(value, candidate.docId)));
            row = findBoundRow(rows, candidate.docId);
          }
          if (!row) throw new Error("迁移时未能建立数据库条目");
          const paper: PaperData = {
            canonical: legacy.canonical,
            citekey: legacy.citekey,
            libraryId: library.docId,
            attachments: legacy.attachments,
            translation: legacy.translation,
          };
          for (const field of LIBRARY_METADATA_FIELDS) {
            const keyId = library.data.fieldKeyIds[field];
            if (!keyId) continue;
            const cell = row.cells.find((item) => item.value.keyID === keyId)?.value;
            if (cellIsEmpty(cell)) {
              await this.kernel.setAttributeViewCell(library.data.avId, keyId, row.id, metadataFieldValue(field, paper));
            }
          }
          if (legacy.projectIds.length && !selectContents(row, library.data.projectKeyId).length) {
            await this.kernel.setAttributeViewCell(
              library.data.avId,
              library.data.projectKeyId,
              row.id,
              projectFieldValue(legacy.projectIds, library.data.projects),
            );
          }
          const statusKeyId = library.data.databaseKeyIds.readingStatus;
          const ratingKeyId = library.data.databaseKeyIds.rating;
          if (statusKeyId && cellIsEmpty(row.cells.find((cell) => cell.value.keyID === statusKeyId)?.value)) {
            await this.kernel.setAttributeViewCell(library.data.avId, statusKeyId, row.id, selectValue([READING_STATUSES[0]], "select"));
          }
          if (ratingKeyId && cellIsEmpty(row.cells.find((cell) => cell.value.keyID === ratingKeyId)?.value)) {
            await this.kernel.setAttributeViewCell(library.data.avId, ratingKeyId, row.id, selectValue(["0"], "select"));
          }
          const attrs = await this.kernel.getBlockAttrs(candidate.docId);
          await this.kernel.setBlockAttrs(candidate.docId, {
            [ATTR.libraryId]: library.docId,
            ...(attrs[ATTR.attachments] ? {} : { [ATTR.attachments]: JSON.stringify(legacy.attachments) }),
            [LEGACY_ATTR.data]: "",
            [LEGACY_ATTR.citekey]: "",
            [LEGACY_ATTR.doi]: "",
            [LEGACY_ATTR.assets]: "",
            [LEGACY_ATTR.libraryItemId]: "",
          });
        } catch (error) {
          console.warn("[paper-manager] 旧版论文数据迁移失败，保留原数据等待重试", candidate.docId, error);
        }
      }
    });
  }

  private async findItemId(data: PaperLibraryData, docId: string): Promise<string> {
    try {
      const mapping = await this.kernel.getAttributeViewItemIDsByBoundIDs(data.avId, [docId]);
      return mapping[docId] ?? "";
    } catch {
      // 老内核没有该端点时回退到整表扫描绑定块。
      const row = findBoundRow(await this.allRows(data), docId);
      return row?.id ?? "";
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

type AttributeViewKeyTypeLike = "created" | "select" | "mSelect" | "text" | "url";

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

/** 从数据库行重建运行时论文数据。 */
export function paperFromRow(
  library: PaperLibraryInfo,
  row: AttributeViewRow,
  docId: string,
  attrs: Record<string, string> = {},
): PaperData {
  return {
    canonical: canonicalFromRow(library.data, row),
    citekey: fieldText(library.data, row, "citekey"),
    libraryId: attrs[ATTR.libraryId] || library.docId,
    attachments: parseAttachments(attrs[ATTR.attachments]),
    translation: {
      mono: attrs[ATTR.translationMono] || undefined,
      dual: attrs[ATTR.translationDual] || undefined,
    },
  };
}

/** 从数据库行重建 canonical；标题取绑定块内容，缺失列跳过。 */
export function canonicalFromRow(data: PaperLibraryData, row: AttributeViewRow): PaperCanonical {
  const text = (field: LibraryMetadataField): string => fieldText(data, row, field);
  const creators = text("authors").split(/[;；]/).map((name) => name.trim()).filter(Boolean)
    .map((name): PaperCreator => {
      const [family = "", ...given] = name.split(/[,，]/).map((part) => part.trim());
      return { family, given: given.join(" "), creatorType: "author" };
    });
  const tags = fieldSelects(data, row, "tags");
  return {
    itemType: fieldSelects(data, row, "itemType")[0] || text("itemType") || "journalArticle",
    title: row.cells.find((cell) => cell.value.block?.content)?.value.block?.content ?? "",
    creators,
    date: text("year") || undefined,
    abstract: text("abstract") || undefined,
    doi: text("doi") || undefined,
    isbn: text("isbn") || undefined,
    issn: text("issn") || undefined,
    url: fieldUrl(data, row, "url") || undefined,
    journal: text("journal") || undefined,
    volume: text("volume") || undefined,
    issue: text("issue") || undefined,
    pages: text("pages") || undefined,
    publisher: text("publisher") || undefined,
    publisherPlace: text("publisherPlace") || undefined,
    language: text("language") || undefined,
    tags,
  };
}

function fieldText(data: PaperLibraryData, row: AttributeViewRow, field: LibraryMetadataField): string {
  const keyId = data.fieldKeyIds[field];
  if (!keyId) return "";
  return row.cells.find((cell) => cell.value.keyID === keyId)?.value.text?.content?.trim() ?? "";
}

function fieldSelects(data: PaperLibraryData, row: AttributeViewRow, field: LibraryMetadataField): string[] {
  const keyId = data.fieldKeyIds[field];
  if (!keyId) return [];
  return selectContents(row, keyId);
}

function fieldUrl(data: PaperLibraryData, row: AttributeViewRow, field: LibraryMetadataField): string {
  const keyId = data.fieldKeyIds[field];
  if (!keyId) return "";
  const value = row.cells.find((cell) => cell.value.keyID === keyId)?.value;
  return value?.url?.content?.trim() ?? value?.text?.content?.trim() ?? "";
}

function cellIsEmpty(value: AttributeViewValue | undefined): boolean {
  if (!value) return true;
  if (value.text) return !value.text.content?.trim();
  if (value.mSelect) return value.mSelect.length === 0;
  if (value.url) return !value.url.content?.trim();
  if (value.number) return !value.number.isNotEmpty;
  if (value.date) return !value.date.isNotEmpty;
  if (value.checkbox) return false;
  return true;
}

function parseAttachments(encoded: string | undefined): PaperData["attachments"] {
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PaperData["attachments"][number] =>
      Boolean(item) && typeof item === "object"
      && typeof (item as { assetAddress?: unknown }).assetAddress === "string");
  } catch {
    return [];
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
