import { fetchSyncPost } from "siyuan";
import type { IWebSocketData } from "siyuan";
import { ATTR } from "../constants";
import { normalizeAssetsDir } from "../types/settings";

export interface KernelPost {
  <T>(endpoint: string, payload: Record<string, unknown>): Promise<T>;
}

export interface NotebookInfo {
  id: string;
  name: string;
  closed?: boolean;
}

export interface CreatedDocument {
  id: string;
  hPath?: string;
  name?: string;
}

export interface BlockOperationResponse {
  doOperations?: Array<{ id?: string; action?: string; data?: string }>;
}

export interface WorkspaceInfo {
  workspaceDir: string;
  [key: string]: unknown;
}

export interface SqlRow {
  id?: string;
  [key: string]: unknown;
}

export interface DocumentSearchResult {
  id: string;
  title: string;
  hPath: string;
  notebookId: string;
}

export type AttributeViewKeyType = "text" | "number" | "date" | "select" | "mSelect" | "url" | "email" | "phone" | "mAsset" | "template" | "created" | "updated" | "checkbox" | "relation" | "rollup" | "lineNumber";

export interface AttributeViewValue {
  id?: string;
  keyID?: string;
  blockID?: string;
  isDetached?: boolean;
  type?: string;
  block?: { id?: string; content?: string };
  text?: { content?: string };
  number?: { content?: number; isNotEmpty?: boolean };
  date?: { content?: number; isNotEmpty?: boolean };
  mSelect?: Array<{ content: string; color?: string }>;
  url?: { content?: string };
  checkbox?: { checked?: boolean };
}

export interface AttributeViewCell { id?: string; value: AttributeViewValue }
export interface AttributeViewRow { id: string; cells: AttributeViewCell[] }
export interface AttributeViewColumn { id: string; name: string; type: string }
export interface RenderedAttributeView {
  id: string;
  name: string;
  viewID: string;
  viewType: string;
  view: {
    columns?: AttributeViewColumn[];
    rows?: AttributeViewRow[];
    rowCount?: number;
  };
}

export interface AttributeViewDefinition {
  av: {
    id: string;
    name: string;
    keyValues: Array<{ key: { id: string; name: string; type: string; options?: Array<{ name: string; color: string; desc?: string }> }; values?: AttributeViewValue[] }>;
    views?: Array<{ id: string; type: string; itemIds?: string[] }>;
  };
}

export class KernelClient {
  private readonly postImpl: KernelPost;
  private readonly fetchImpl: typeof fetch;

  constructor(postImpl?: KernelPost, fetchImpl: typeof fetch = globalThis.fetch) {
    this.postImpl = postImpl ?? defaultPost;
    // Chromium's native fetch performs a brand check. Calling a function stored
    // directly on `this` changes its receiver to KernelClient and causes
    // "Illegal invocation" in SiYuan's Electron window.
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const data = await this.postImpl<{ notebooks?: NotebookInfo[] }>("/api/notebook/lsNotebooks", {});
    return (data.notebooks ?? []).filter((notebook) => !notebook.closed);
  }

  async createDocument(notebook: string, path: string, markdown: string, title: string): Promise<CreatedDocument> {
    const data = await this.postImpl<string | Record<string, unknown>>("/api/filetree/createDocWithMd", {
      notebook,
      path,
      markdown,
      title,
    });
    if (typeof data === "string") return { id: data, name: title };
    const id = string(data.id ?? data.rootID);
    if (!id) throw new Error("createDocWithMd 未返回文档 ID");
    return { id, hPath: string(data.hPath) || undefined, name: string(data.name) || title };
  }

  async setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
    await this.postImpl("/api/attr/setBlockAttrs", { id, attrs });
  }

  getBlockAttrs(id: string): Promise<Record<string, string>> {
    return this.postImpl<Record<string, string>>("/api/attr/getBlockAttrs", { id });
  }

  getBlockKramdown(id: string): Promise<{ id: string; kramdown: string }> {
    return this.postImpl("/api/block/getBlockKramdown", { id });
  }

  async updateBlock(id: string, data: string, dataType: "markdown" | "dom", lockType = true): Promise<void> {
    await this.postImpl("/api/block/updateBlock", { id, data, dataType, lockType });
  }

  async appendBlock(parentID: string, data: string, dataType: "markdown" | "dom" = "markdown"): Promise<string[]> {
    const result = await this.postImpl<BlockOperationResponse[]>("/api/block/appendBlock", { parentID, data, dataType });
    return operationIds(result);
  }

  async deleteBlock(id: string): Promise<void> {
    await this.postImpl("/api/block/deleteBlock", { id });
  }

  async appendAttributeViewBlock(parentID: string, blockID: string, avID: string): Promise<string> {
    const dom = `<div class="av" data-node-id="${blockID}" data-av-id="${avID}" data-type="NodeAttributeView" data-av-type="table"></div>`;
    const ids = await this.appendBlock(parentID, dom, "dom");
    return ids.includes(blockID) ? blockID : ids[0] ?? blockID;
  }

  renderAttributeView(
    avID: string,
    blockID: string,
    page = 1,
    pageSize = 100,
    createIfNotExist = false,
  ): Promise<RenderedAttributeView> {
    return this.postImpl("/api/av/renderAttributeView", {
      id: avID, blockID, page, pageSize, query: "", groupPaging: {}, createIfNotExist,
    });
  }

  getAttributeView(avID: string): Promise<AttributeViewDefinition> {
    return this.postImpl("/api/av/getAttributeView", { id: avID });
  }

  async setAttributeViewName(avID: string, name: string): Promise<void> {
    await this.postImpl("/api/transactions", {
      reqId: Date.now(),
      session: "paper-manager",
      app: "siyuan",
      transactions: [{ doOperations: [{ action: "setAttrViewName", id: avID, data: name }], undoOperations: [] }],
    });
  }

  async setAttributeViewSelectOptions(avID: string, keyID: string, names: string[], preserveExisting = false): Promise<void> {
    const options = preserveExisting
      ? [...((await this.getAttributeView(avID)).av.keyValues.find(({ key }) => key.id === keyID)?.key.options ?? [])]
      : [];
    const existing = new Set(options.map((option) => option.name));
    const originalCount = options.length;
    for (const name of names) {
      if (existing.has(name)) continue;
      options.push({ name, color: String(options.length % 14 + 1), desc: "" });
      existing.add(name);
    }
    if (preserveExisting && options.length === originalCount) return;
    await this.postImpl("/api/transactions", {
      reqId: Date.now(),
      session: "paper-manager",
      app: "siyuan",
      transactions: [{
        doOperations: [{
          action: "updateAttrViewColOptions",
          id: keyID,
          avID,
          data: options,
        }],
        undoOperations: [],
      }],
    });
  }

  async addAttributeViewKey(
    avID: string,
    keyID: string,
    keyName: string,
    keyType: AttributeViewKeyType,
    previousKeyID = "",
  ): Promise<void> {
    await this.postImpl("/api/av/addAttributeViewKey", {
      avID, keyID, keyName, keyType, keyIcon: "", previousKeyID,
    });
  }

  async removeAttributeViewKey(avID: string, keyID: string): Promise<void> {
    await this.postImpl("/api/av/removeAttributeViewKey", { avID, keyID, removeRelationDest: false });
  }

  /**
   * 块 → 数据库条目的直接关联查询（思源 3.3.1+）。
   * 返回 blockID → itemID 映射，非条目时对应值为空串。
   */
  getAttributeViewItemIDsByBoundIDs(avID: string, blockIDs: string[]): Promise<Record<string, string>> {
    return this.postImpl("/api/av/getAttributeViewItemIDsByBoundIDs", { avID, blockIDs });
  }

  async addAttributeViewBlocks(avID: string, blockID: string, sources: Array<{ id: string; content: string }>): Promise<void> {
    await this.postImpl("/api/av/addAttributeViewBlocks", {
      avID,
      blockID,
      viewID: "",
      groupID: "",
      previousID: "",
      srcs: sources.map((source) => ({ ...source, isDetached: false })),
      ignoreDefaultFill: true,
    });
  }

  async removeAttributeViewBlocks(avID: string, itemIDs: string[]): Promise<void> {
    if (!itemIDs.length) return;
    await this.postImpl("/api/av/removeAttributeViewBlocks", { avID, srcIDs: itemIDs });
  }

  async setAttributeViewCell(avID: string, keyID: string, itemID: string, value: AttributeViewValue): Promise<void> {
    await this.postImpl("/api/av/setAttributeViewBlockAttr", { avID, keyID, itemID, value });
  }

  async renameDocument(id: string, title: string): Promise<void> {
    await this.postImpl("/api/filetree/renameDocByID", { id, title });
  }

  async getDocumentInfo(id: string): Promise<DocumentSearchResult | undefined> {
    const rows = await this.query(
      `SELECT id, content, hpath, box FROM blocks WHERE type = 'd' AND id = ${sqlString(id)} LIMIT 1`,
    );
    return documentSearchResult(rows[0]);
  }

  async searchDocuments(keyword: string, limit = 20): Promise<DocumentSearchResult[]> {
    const query = keyword.trim();
    if (!query) return [];
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const pattern = sqlString(`%${escapeLike(query)}%`);
    const rows = await this.query(
      `SELECT id, content, hpath, box FROM blocks WHERE type = 'd' `
      + `AND (content LIKE ${pattern} ESCAPE '\\' OR hpath LIKE ${pattern} ESCAPE '\\') `
      + `ORDER BY updated DESC LIMIT ${safeLimit}`,
    );
    return rows.map(documentSearchResult).filter((row): row is DocumentSearchResult => Boolean(row));
  }

  async listRowsByAttribute(name: string, value?: string): Promise<SqlRow[]> {
    const condition = value === undefined ? "" : ` AND a.value = ${sqlString(value)}`;
    return this.query(
      `SELECT a.block_id AS id, a.value, b.content, b.hpath, b.box FROM attributes a `
      + `JOIN blocks b ON b.id = a.block_id WHERE b.type = 'd' AND a.name = ${sqlString(name)}${condition}`,
    );
  }

  query(stmt: string): Promise<SqlRow[]> {
    if (!/^\s*select\b/i.test(stmt)) throw new Error("仅允许只读 SELECT 查询");
    return this.postImpl<SqlRow[]>("/api/query/sql", { stmt });
  }

  async findSectionBlock(docId: string, section: "meta" | "note"): Promise<string | null> {
    const rows = await this.query(
      `SELECT a.block_id AS id FROM attributes a JOIN blocks b ON b.id = a.block_id `
      + `WHERE b.root_id = ${sqlString(docId)} AND a.name = ${sqlString(ATTR.section)} `
      + `AND a.value = ${sqlString(section)} LIMIT 1`,
    );
    return string(rows[0]?.id) || null;
  }

  async listTopLevelSuperBlocks(docId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT id FROM blocks WHERE root_id = ${sqlString(docId)} `
      + `AND parent_id = ${sqlString(docId)} AND type = 's' ORDER BY sort ASC`,
    );
    return rows.map((row) => string(row.id)).filter(Boolean);
  }

  /** 返回文档的父文档 ID（依据 blocks.path 的层级段），无父文档时返回空串。 */
  async parentDocumentId(docId: string): Promise<string> {
    const rows = await this.query(
      `SELECT path FROM blocks WHERE type = 'd' AND id = ${sqlString(docId)} LIMIT 1`,
    );
    const path = string(rows[0]?.path);
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2) return "";
    return (segments[segments.length - 2] ?? "").replace(/\.sy$/, "");
  }

  getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return this.postImpl<WorkspaceInfo>("/api/system/getWorkspaceInfo", {});
  }

  async readPluginFile(path: string): Promise<string> {
    const response = await this.fetchImpl(`${apiBase()}/api/file/getFile`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(`file/getFile HTTP ${response.status}`);
    return response.text();
  }

  async uploadAsset(assetsDir: string, bytes: Uint8Array, filename: string, mimeType: string): Promise<string> {
    const normalizedDir = normalizeAssetsDir(assetsDir);
    const safeFilename = sanitizeFilename(filename);
    const form = new FormData();
    form.append("assetsDirPath", normalizedDir);
    form.append("file[]", new File([bytes as BlobPart], safeFilename, { type: mimeType || "application/octet-stream" }), safeFilename);
    const response = await this.fetchImpl(`${apiBase()}/api/asset/upload`, {
      method: "POST",
      headers: tokenHeaders(),
      body: form,
    });
    if (!response.ok) throw new Error(`asset/upload HTTP ${response.status}`);
    const payload = await response.json() as {
      code: number;
      msg?: string;
      data?: { succMap?: Record<string, string> };
    };
    if (payload.code !== 0) throw new Error(`asset/upload 失败: ${payload.msg || payload.code}`);
    const address = Object.values(payload.data?.succMap ?? {})[0];
    if (!address) throw new Error("asset/upload 未返回资源地址");
    return normalizeAssetAddress(address, normalizedDir);
  }

  async removeWorkspaceFile(path: string): Promise<void> {
    if (!path.startsWith("/data/") || path.includes("..")) throw new Error(`拒绝删除工作空间路径：${path}`);
    await this.postImpl("/api/file/removeFile", { path });
  }
}

async function defaultPost<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  const response = await withTimeout(fetchSyncPost(endpoint, payload), 30_000, endpoint);
  return unwrap<T>(response, endpoint);
}

function unwrap<T>(response: IWebSocketData | undefined, endpoint: string): T {
  if (!response || response.code !== 0) {
    throw new Error(`${endpoint} 失败: ${response?.msg || `code=${String(response?.code)}`}`);
  }
  return response.data as T;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function apiBase(): string {
  const config = (globalThis as typeof globalThis & {
    window?: { siyuan?: { config?: { apiUrl?: string } } };
  }).window?.siyuan?.config;
  if (config?.apiUrl) return config.apiUrl.replace(/\/+$/, "");
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? origin : "http://127.0.0.1:6806";
}

function apiToken(): string {
  return (globalThis as typeof globalThis & {
    window?: { siyuan?: { config?: { apiToken?: string } } };
  }).window?.siyuan?.config?.apiToken ?? "";
}

function tokenHeaders(): Record<string, string> {
  const token = apiToken();
  return token ? { Authorization: `Token ${token}` } : {};
}

function jsonHeaders(): Record<string, string> {
  return { ...tokenHeaders(), "Content-Type": "application/json" };
}

function normalizeAssetAddress(address: string, directory: string): string {
  const clean = address.replace(/\\/g, "/").replace(/^\/+/, "");
  const expected = directory.replace(/^\/+/, "");
  if (clean.startsWith(expected)) return clean;
  if (expected === "assets/") return clean.startsWith("assets/") ? clean : `assets/${clean}`;
  const filename = clean.split("/").at(-1) ?? clean;
  return `${expected}${filename}`;
}

function sanitizeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  return filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "attachment.bin";
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function documentSearchResult(row: SqlRow | undefined): DocumentSearchResult | undefined {
  if (!row?.id) return undefined;
  return {
    id: String(row.id),
    title: string(row.content) || "无标题文档",
    hPath: string(row.hpath),
    notebookId: string(row.box),
  };
}

function string(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function operationIds(responses: BlockOperationResponse[]): string[] {
  return responses.flatMap((response) => response.doOperations ?? [])
    .map((operation) => operation.id ?? "")
    .filter(Boolean);
}
