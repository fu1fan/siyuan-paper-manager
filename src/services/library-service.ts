import { ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import { decodeLibraryData, encodeLibraryData } from "../core/codec";
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
    const output = await this.listLibraryRefs();
    for (const library of output) {
      try { await this.ensureSchemaFields(library); }
      catch (error) { console.warn("[paper-manager] 数据库字段初始化失败，可在设置中重试修复", library.docId, error); }
    }
    return output;
  }

  /** 轻量列举全部文献库（仅解码，无对齐/迁移副作用），供论文页识别兜底扫描。 */
  private async listLibraryRefs(): Promise<PaperLibraryInfo[]> {
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
    // 文档正文不放 H1：文献库页的内容就是数据库本身，避免标题层层重复
    const created = await this.kernel.createDocument(notebookId, hPath, "", title);
    const avId = newNodeId();
    const requestedBlockId = newNodeId();
    const avBlockId = await this.kernel.appendAttributeViewBlock(created.id, requestedBlockId, avId);
    await this.kernel.renderAttributeView(avId, avBlockId, 1, 100, true);
    await this.setAttributeViewNameSafely(avId, "文献数据库");
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
      // 对齐失败不应拖垮论文页识别等只读路径，设置页「修复数据库」可重试。
      try { await this.ensureSchemaFields(library); }
      catch (error) { console.warn("[paper-manager] 数据库字段对齐失败，可在设置中修复", docId, error); }
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
   * 判断文档是否为论文页：优先查父文档的数据库；父文档不是文献库或
   * 库里没有条目时，兜底扫描所有文献库（论文可能被移动过位置）。
   * 条目与页面的关联通过内核 getAttributeViewItemIDsByBoundIDs 直接查询。
   */
  async findPaperEntry(docId: string): Promise<PaperEntry | null> {
    const { entry, reason } = await this.lookupPaperEntry(docId);
    if (!entry) console.debug("[paper-manager] 论文页识别未命中", docId, reason);
    return entry;
  }

  /** 同 findPaperEntry，但未命中时抛出带具体环节原因的错误。 */
  async requirePaperEntry(docId: string): Promise<PaperEntry> {
    const { entry, reason } = await this.lookupPaperEntry(docId);
    if (!entry) throw new Error(`当前文档不是论文页：${reason}`);
    return entry;
  }

  private async lookupPaperEntry(docId: string): Promise<{ entry: PaperEntry | null; reason: string }> {
    let parentId = "";
    try {
      parentId = await this.kernel.parentDocumentId(docId);
    } catch (error) {
      console.warn("[paper-manager] 读取文档层级失败", docId, error);
    }
    let parentChecked = false;
    if (parentId) {
      try {
        const parentAttrs = await this.kernel.getBlockAttrs(parentId);
        if (parentAttrs[ATTR.libraryData]) {
          parentChecked = true;
          const library = await this.getLibrary(parentId);
          const entry = await this.entryInLibrary(library, docId);
          if (entry) return { entry, reason: "" };
        }
      } catch (error) {
        console.warn("[paper-manager] 父页数据库查询失败，转为全库扫描", parentId, error);
      }
    }
    try {
      const libraries = await this.listLibraryRefs();
      for (const library of libraries) {
        if (parentChecked && library.docId === parentId) continue;
        const entry = await this.entryInLibrary(library, docId);
        if (entry) return { entry, reason: "" };
      }
      return {
        entry: null,
        reason: libraries.length
          ? "所有文献库数据库中都没有绑定该文档的条目（若刚导入，请先在设置中对文献库点一次「重新同步」）"
          : "工作空间中还没有论文文献库",
      };
    } catch (error) {
      return { entry: null, reason: `文献库扫描失败：${message(error)}` };
    }
  }

  private async entryInLibrary(library: PaperLibraryInfo, docId: string): Promise<PaperEntry | null> {
    const itemId = await this.findItemId(library.data, docId);
    const rows = await this.allRows(library.data);
    const row = (itemId ? rows.find((candidate) => candidate.id === itemId) : undefined)
      ?? findBoundRow(rows, docId);
    if (!row) return null;
    return { library, itemId: row.id, row };
  }

  /** 从数据库行重建论文数据；附件与翻译产物等机器状态读文档属性。 */
  async readPaper(docId: string, knownEntry?: PaperEntry): Promise<PaperData> {
    const entry = knownEntry ?? await this.requirePaperEntry(docId);
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
        // 确认建行优先直读条目关联映射（直读 av 数据）：renderAttributeView
        // 是视图渲染快照，内核异步落库期间可能持续返回旧数据，导致导入后
        // 短期内识别不到论文页。映射不可用（老内核）时回退到视图轮询。
        let itemId = await this.findItemId(library.data, docId);
        if (itemId === "") {
          itemId = await retry(
            () => this.findItemId(library.data, docId),
            (value) => value !== "" && value !== null,
            8,
            250,
          );
        }
        if (itemId) {
          row = { id: itemId, cells: [{ value: { block: { id: docId, content: paper.canonical.title } } }] };
        } else {
          rows = await retry(() => this.allRows(library.data), (value) => Boolean(findBoundRow(value, docId)), 8, 250);
          row = findBoundRow(rows, docId);
        }
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
    try { await this.ensureSchemaFields(library); }
    catch (error) { console.warn("[paper-manager] 同步前对齐数据库字段失败", libraryDocId, error); }
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
    await this.backfillTitles(library);
    return { papers: members.size, restoredRows, removedRows: stale.length, failed };
  }

  /** 标题列后补：旧行的标题单元格为空时，用论文页首个 H1 回填。 */
  private async backfillTitles(library: PaperLibraryInfo): Promise<void> {
    const keyId = library.data.fieldKeyIds.title;
    if (!keyId) return;
    let pending: AttributeViewRow[] = [];
    try {
      const rows = await this.allRows(library.data);
      pending = rows.filter((row) => boundBlockId(row) && !fieldText(library.data, row, "title"));
    } catch (error) {
      console.warn("[paper-manager] 标题回填扫描失败", error);
      return;
    }
    if (!pending.length) return;
    const docIds = pending.map((row) => boundBlockId(row));
    const headings = await this.kernel.query(
      `SELECT root_id, content FROM blocks WHERE type = 'h' AND subtype = 'h1' AND root_id IN (${docIds.map((id) => `'${sql(id)}'`).join(", ")})`,
    );
    const titleByDoc = new Map<string, string>();
    for (const heading of headings) {
      const rootId = String(heading.root_id ?? "");
      if (rootId && !titleByDoc.has(rootId)) titleByDoc.set(rootId, String(heading.content ?? "").trim());
    }
    for (const row of pending) {
      const title = titleByDoc.get(boundBlockId(row));
      if (!title) continue;
      try {
        await this.kernel.setAttributeViewCell(library.data.avId, keyId, row.id, textValue(title));
      } catch (error) {
        console.warn("[paper-manager] 标题回填失败", row.id, error);
      }
    }
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
    await this.setAttributeViewNameSafely(avId, "文献数据库");
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

  private async findItemId(data: PaperLibraryData, docId: string): Promise<string | null> {
    try {
      const mapping = await this.kernel.getAttributeViewItemIDsByBoundIDs(data.avId, [docId]);
      return mapping[docId] ?? "";
    } catch (error) {
      // 老内核（< 3.3.1）没有该端点，返回 null 表示不可用；
      // entryInLibrary 会再按绑定块整表扫描兜底。
      console.debug("[paper-manager] 条目关联查询不可用，回退到整表扫描", error);
      return null;
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
    case "title": return c.title;
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
    // 文档名即 citekey，块列内容不再是标题；标题列优先，兼容旧行回退块列
    title: text("title") || row.cells.find((cell) => cell.value.block?.content)?.value.block?.content || "",
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

async function retry<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  attempts = 5,
  delayMs = 120,
): Promise<T> {
  let value = await fn();
  for (let attempt = 0; attempt < attempts && !predicate(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    value = await fn();
  }
  return value;
}

function sql(value: string): string {
  return value.replace(/'/g, "''");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
