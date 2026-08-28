import { fetchSyncPost } from "siyuan";
import type { IWebSocketData } from "siyuan";
import type { PaperData } from "../types/paper";
import { ATTR } from "../constants";
import { decodePaperData } from "./codec";
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

export interface NativeTemplateResult {
  content: string;
  path?: string;
}

export interface WorkspaceInfo {
  workspaceDir: string;
  [key: string]: unknown;
}

export interface SqlRow {
  id?: string;
  [key: string]: unknown;
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

  async getPaperData(id: string): Promise<PaperData> {
    const attrs = await this.getBlockAttrs(id);
    const encoded = attrs[ATTR.data];
    if (!encoded) throw new Error("当前文档不是论文元数据页");
    return decodePaperData(encoded);
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

  async findPaperDocIdsByIndex(name: string, value: string, limit = 20): Promise<string[]> {
    if (!Object.values(ATTR).includes(name as never)) throw new Error("未知索引属性");
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await this.query(
      `SELECT a.block_id AS id FROM attributes a JOIN blocks b ON b.id = a.block_id `
      + `WHERE b.type = 'd' AND a.name = ${sqlString(name)} AND a.value = ${sqlString(value)} `
      + `LIMIT ${safeLimit}`,
    );
    return rows.map((row) => string(row.id)).filter(Boolean);
  }

  getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return this.postImpl<WorkspaceInfo>("/api/system/getWorkspaceInfo", {});
  }

  async renderNativeTemplate(
    id: string,
    absolutePath: string,
    context: Record<string, unknown>,
  ): Promise<NativeTemplateResult> {
    const data = await this.postImpl<string | NativeTemplateResult>("/api/template/render", {
      id,
      path: absolutePath,
      data: JSON.stringify(context),
    });
    if (typeof data === "string") return { content: data };
    if (!data || typeof data.content !== "string") throw new Error("template/render 返回结构异常");
    return data;
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

function string(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function operationIds(responses: BlockOperationResponse[]): string[] {
  return responses.flatMap((response) => response.doOperations ?? [])
    .map((operation) => operation.id ?? "")
    .filter(Boolean);
}
