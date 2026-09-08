import { version } from "../../package.json";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONNECTOR_API_VERSION,
  CONNECTOR_GRACE_MS,
  CONNECTOR_SESSION_TTL_MS,
  MAX_JSON_BODY_BYTES,
  SOURCE,
} from "../constants";
import type { ImportAttachment, ImportCandidate, ZoteroAttachmentMetadata } from "../types/import";
import { canonicalFromRaw } from "../core/normalize";
import { getNodeRequire, type NodeRequire, requireNode } from "../core/env";

interface ConnectorItem {
  id: string;
  raw: Record<string, unknown>;
  imported: boolean;
  docId?: string;
  error?: string;
  delivered: Set<string>;
}

interface StoredAttachment extends ImportAttachment {
  id: string;
}

interface ConnectorSession {
  id: string;
  uri?: string;
  items: ConnectorItem[];
  attachments: StoredAttachment[];
  createdAt: number;
  updatedAt: number;
  expectedAttachments: number;
  pendingUploads: number;
  processing?: Promise<void>;
  attachmentStatus: Map<string, { id: string; parentItemId: string; title: string; progress: number | false; error?: string }>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ConnectorServerOptions {
  port: number;
  tempDirectory: string;
  requireFn?: NodeRequire;
  onImport: (candidate: ImportCandidate) => string | void | Promise<string | void>;
  onAdditionalAttachments?: (docId: string, attachments: ImportAttachment[]) => Promise<void>;
  onStatus?: (status: { listening: boolean; port: number; error?: string }) => void;
  onProtocolError?: (message: string) => void;
  graceMs?: number;
  sessionTtlMs?: number;
  attachmentWaitMs?: number;
}

export class ConnectorServer {
  private readonly requireFn: NodeRequire;
  private server: import("node:http").Server | null = null;
  private readonly sessions = new Map<string, ConnectorSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ConnectorServerOptions) {
    const requireFn = options.requireFn ?? getNodeRequire();
    if (!requireFn) throw new Error("window.require 不可用，仅支持思源桌面端");
    this.requireFn = requireFn;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const http = requireNode<typeof import("node:http")>("http", this.requireFn);
    this.ensureTempDirectory();
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[paper-manager] Connector 请求失败", error);
        this.options.onProtocolError?.(message);
        if (!response.headersSent) this.respondJson(response, error instanceof ProtocolError ? error.status : 500, { error: message });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, "127.0.0.1");
    }).catch((error) => {
      this.server = null;
      const message = connectorStartError(error);
      this.options.onStatus?.({ listening: false, port: this.options.port, error: message });
      throw new Error(message);
    });
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.options.onStatus?.({ listening: true, port: this.options.port });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
    await Promise.allSettled(sessions.map((session) => session.processing));
    for (const session of sessions) for (const attachment of session.attachments) this.removeTempFile(attachment.tempPath);
    this.options.onStatus?.({ listening: false, port: this.options.port });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    const apiVersion = Number(header(request, "x-zotero-connector-api-version") || 0);
    if (apiVersion > CONNECTOR_API_VERSION) {
      this.respondJson(response, 412, { error: "Connector API version is newer than supported" });
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const route = url.pathname;
    if (route === "/connector/ping" && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "POST") await readJson(request, MAX_JSON_BODY_BYTES);
      this.handlePing(response);
      return;
    }
    if (request.method !== "POST") {
      this.respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    switch (route) {
      case "/connector/saveItems":
        await this.handleSaveItems(request, response);
        return;
      case "/connector/saveSnapshot":
        await this.handleSaveSnapshot(request, response);
        return;
      case "/connector/saveSingleFile":
        await this.handleSingleFile(request, response);
        return;
      case "/connector/saveAttachment":
        await this.handleAttachment(request, response, url);
        return;
      case "/connector/saveStandaloneAttachment":
        await this.handleStandaloneAttachment(request, response, url);
        return;
      case "/connector/sessionProgress":
        await this.handleSessionProgress(request, response, url);
        return;
      case "/connector/getSelectedCollection":
        this.respondJson(response, 200, {
          editable: true,
          libraryEditable: true,
          targets: [{ id: "siyuan-paper-manager", name: "SiYuan Paper Manager", type: "library", libraryID: 1, level: 0, filesEditable: true }],
          id: "siyuan-paper-manager",
          name: "SiYuan Paper Manager",
          libraryID: 1,
          libraryName: "SiYuan",
          filesEditable: true,
        });
        return;
      case "/connector/hasAttachmentResolvers":
        await readJson(request, MAX_JSON_BODY_BYTES);
        this.respondJson(response, 200, false);
        return;
      case "/connector/updateSession":
      case "/connector/delaySync":
        await readJson(request, MAX_JSON_BODY_BYTES);
        this.respondJson(response, 200, {});
        return;
      default:
        this.respondJson(response, 501, { error: `unsupported endpoint: ${route}` });
    }
  }

  private handlePing(response: ServerResponse): void {
    this.respondJson(response, 200, {
      authenticated: false,
      loggedIn: false,
      storage: [1, 0, 0],
      prefs: {
        downloadAssociatedFiles: true,
        automaticSnapshots: true,
        reportActiveURL: false,
        googleDocsAddNoteEnabled: false,
        googleDocsCitationExplorerEnabled: false,
        supportsAttachmentUpload: true,
        // Do not advertise a translator database: Connector manages its own translators.
      },
      version: `SiYuan Paper Manager ${version}`,
    });
  }

  private async handleSaveItems(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson(request, MAX_JSON_BODY_BYTES);
    const items = Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
    if (!items.length) {
      this.respondJson(response, 400, { error: "items is required" });
      return;
    }
    this.saveSession(payload, items, response);
  }

  private async handleSaveSnapshot(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson(request, MAX_JSON_BODY_BYTES);
    const rawItems = Array.isArray(payload.items) && payload.items.some(isRecord)
      ? payload.items.filter(isRecord)
      : [isRecord(payload.item) ? payload.item : {
          ...payload,
          itemType: "webpage",
          title: string(payload.title) || string(payload.url) || "网页快照",
          url: string(payload.url),
        }];
    this.saveSession(payload, rawItems, response);
  }

  private saveSession(payload: Record<string, unknown>, items: Record<string, unknown>[], response: ServerResponse): void {
    const sessionId = cleanId(payload.sessionID) || randomId();
    // Connector 会重发请求；活动会话也必须幂等，不能覆盖已上传附件与定时器。
    if (!this.sessions.has(sessionId)) {
      const now = Date.now();
      const session: ConnectorSession = {
        id: sessionId,
        uri: string(payload.uri ?? payload.url) || undefined,
        items: items.map((raw, index) => ({ id: itemId(raw, index), raw: cloneRecord(raw), imported: false, delivered: new Set<string>() })),
        attachments: [], createdAt: now, updatedAt: now,
        expectedAttachments: expectedAttachmentCount(items), pendingUploads: 0, attachmentStatus: new Map(),
      };
      for (const item of session.items) {
        for (const raw of Array.isArray(item.raw.attachments) ? item.raw.attachments.filter(isRecord) : []) {
          if (raw.snapshot === false || raw.linkMode === "linked_url") continue;
          const id = cleanId(raw.id);
          if (id) session.attachmentStatus.set(id, { id, parentItemId: item.id, title: string(raw.title), progress: 0 });
        }
      }
      this.sessions.set(sessionId, session);
      this.scheduleDispatch(session, session.expectedAttachments ? this.options.attachmentWaitMs ?? 5 * 60_000 : undefined);
    }
    const session = this.sessions.get(sessionId)!;
    session.updatedAt = Date.now();
    this.respondJson(response, 201, { sessionID: sessionId, items: session.items.map((item) => ({ ...item.raw, id: item.id })), saveSingleFile: true });
  }

  private async handleAttachment(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.requireSession(url.searchParams.get("sessionID") ?? url.searchParams.get("session"));
    const metadata = attachmentMetadata(request);
    metadata.contentType ||= header(request, "content-type").split(";", 1)[0];
    const parent = this.attachmentParent(session, metadata.parentItemID ?? metadata.parentItem);
    if (parent.error) throw new ProtocolError(409, `论文导入失败：${parent.error}`);
    metadata.parentItemID = parent.id;
    metadata.id = cleanId(metadata.id) || randomId();
    const known = session.attachmentStatus.get(metadata.id);
    if (known && known.parentItemId !== parent.id) throw new ProtocolError(400, "附件ID已属于另一篇论文");
    const previous = session.attachments.find((item) => item.id === metadata.id);
    if (previous && session.attachmentStatus.get(metadata.id)?.progress !== false) {
      request.resume();
      this.respondJson(response, 201, { id: metadata.id, progress: 100 });
      return;
    }
    if (previous) {
      this.removeTempFile(previous.tempPath);
      session.attachments = session.attachments.filter((attachment) => attachment !== previous);
      parent.delivered.delete(metadata.id);
    }
    session.pendingUploads += 1;
    session.updatedAt = Date.now();
    session.attachmentStatus.set(metadata.id, { id: metadata.id, parentItemId: parent.id, title: metadata.title || "附件", progress: 0 });
    try {
      const attachment = await this.streamAttachment(request, metadata);
      if (this.sessions.get(session.id) !== session) {
        this.removeTempFile(attachment.tempPath);
        throw new ProtocolError(409, "session closed");
      }
      this.storeAttachment(session, attachment);
    } catch (error) {
      session.attachmentStatus.get(metadata.id)!.progress = false;
      session.attachmentStatus.get(metadata.id)!.error = errorMessage(error);
      throw error;
    } finally {
      session.pendingUploads -= 1;
      session.updatedAt = Date.now();
      // Modern Connectors omit the attachment list in saveItems. Keep the session
      // and patch its existing document even if the download finishes much later.
      if (session.items.some((item) => item.imported) || this.attachmentsArrived(session)) this.scheduleDispatch(session);
    }
    if (parent.imported) await this.flushAttachment(session, metadata.id);
    this.respondJson(response, 201, { id: metadata.id, progress: 100 });
  }

  private async handleSingleFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson(request, 64 * 1024 * 1024);
    const session = this.requireSession(payload.sessionID);
    if (typeof payload.snapshotContent !== "string" || !payload.snapshotContent.trim()) throw new ProtocolError(400, "snapshotContent must be HTML text");
    const rawItem = Array.isArray(payload.items) ? payload.items.find(isRecord) : undefined;
    const parent = this.attachmentParent(session, payload.parentItemID ?? rawItem?.id);
    if (parent.error) throw new ProtocolError(409, `论文导入失败：${parent.error}`);
    const placeholder = [...session.attachmentStatus.values()].find((entry) => entry.parentItemId === parent.id && session.items.some((item) =>
      Array.isArray(item.raw.attachments) && item.raw.attachments.some((a) => isRecord(a) && cleanId(a.id) === entry.id && a.mimeType === "text/html")));
    const id = cleanId(payload.id) || placeholder?.id || `snapshot-${parent.id}`;
    const existing = session.attachments.find((attachment) => attachment.id === id);
    if (!existing || session.attachmentStatus.get(id)?.progress === false) {
      if (existing) {
        this.removeTempFile(existing.tempPath);
        session.attachments = session.attachments.filter((attachment) => attachment !== existing);
        parent.delivered.delete(id);
      }
      const fs = requireNode<typeof import("node:fs")>("fs", this.requireFn);
      const path = requireNode<typeof import("node:path")>("path", this.requireFn);
      const tempPath = path.join(this.options.tempDirectory, `${randomId()}-${id}.html`);
      fs.writeFileSync(tempPath, payload.snapshotContent, "utf8");
      this.storeAttachment(session, { id, connectorId: id, parentItemId: parent.id,
        title: string(payload.title) || "网页快照", mimeType: "text/html", sourceUrl: string(payload.url) || session.uri, tempPath });
    }
    if (session.items.some((item) => item.imported) || this.attachmentsArrived(session)) this.scheduleDispatch(session);
    if (parent.imported) await this.flushAttachment(session, id);
    response.statusCode = 204;
    response.end();
  }

  private async handleStandaloneAttachment(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const metadata = attachmentMetadata(request);
    metadata.contentType ||= header(request, "content-type").split(";", 1)[0];
    const sessionId = cleanId(url.searchParams.get("sessionID")) || randomId();
    let session = this.sessions.get(sessionId);
    if (session?.items[0]?.imported) { request.resume(); this.respondJson(response, 201, { canRecognize: false }); return; }
    metadata.id = cleanId(metadata.id) || `standalone-${sessionId}`;
    const attachment = await this.streamAttachment(request, metadata);
    const id = attachment.parentItemId = "standalone";
    const raw = { id, itemType: "document", title: metadata.title || metadata.filename || "独立附件", url: metadata.url };
    if (!session) {
      session = { id: sessionId, uri: string(metadata.url), items: [{ id, raw, imported: false, delivered: new Set() }],
        attachments: [], attachmentStatus: new Map(), createdAt: Date.now(), updatedAt: Date.now(), expectedAttachments: 1, pendingUploads: 0 };
      this.sessions.set(sessionId, session);
    }
    this.storeAttachment(session, attachment);
    this.scheduleDispatch(session);
    this.respondJson(response, 201, { id: attachment.id, canRecognize: false });
  }

  private requireSession(value: unknown): ConnectorSession {
    const id = cleanId(value);
    const session = this.sessions.get(id);
    if (!session) throw new ProtocolError(404, `unknown session: ${id}`);
    return session;
  }

  private attachmentParent(session: ConnectorSession, value: unknown): ConnectorItem {
    const id = cleanId(value);
    const parent = id ? session.items.find((item) => item.id === id) : session.items.length === 1 ? session.items[0] : undefined;
    if (!parent) throw new ProtocolError(400, "附件缺少有效的 parentItemID，无法确定所属论文");
    return parent;
  }

  private storeAttachment(session: ConnectorSession, attachment: StoredAttachment): void {
    const existing = session.attachments.findIndex((item) => item.id === attachment.id);
    if (existing >= 0) {
      if (session.attachmentStatus.get(attachment.id)?.progress !== false) { this.removeTempFile(attachment.tempPath); return; }
      this.removeTempFile(session.attachments[existing]?.tempPath);
      session.attachments[existing] = attachment;
    } else session.attachments.push(attachment);
    for (const item of session.items) item.delivered.delete(attachment.id);
    session.updatedAt = Date.now();
    session.attachmentStatus.set(attachment.id, { id: attachment.id, parentItemId: attachment.parentItemId!, title: attachment.title, progress: 0 });
  }

  private attachmentsArrived(session: ConnectorSession): boolean {
    return session.attachments.length + [...session.attachmentStatus.values()].filter((status) => status.progress === false).length >= session.expectedAttachments;
  }

  private async handleSessionProgress(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const payload = await readJson(request, MAX_JSON_BODY_BYTES);
    const session = this.requireSession(payload.sessionID ?? url.searchParams.get("sessionID") ?? url.searchParams.get("session"));
    this.respondJson(response, 200, {
      done: !session.pendingUploads && !session.processing && session.items.every((item) => item.imported || item.error)
        && [...session.attachmentStatus.values()].every((entry) => entry.progress === 100 || entry.progress === false),
      items: session.items.map((item) => ({ id: item.id, title: string(item.raw.title), progress: item.error ? false : item.imported ? 100 : 0,
        error: item.error, attachments: [...session.attachmentStatus.values()].filter((entry) => entry.parentItemId === item.id) })),
    });
  }

  private scheduleDispatch(session: ConnectorSession, delayMs?: number): void {
    if (!this.server || this.sessions.get(session.id) !== session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(
      () => this.dispatchSession(session.id),
      delayMs ?? this.options.graceMs ?? CONNECTOR_GRACE_MS,
    );
  }

  private async flushAttachment(session: ConnectorSession, id: string): Promise<void> {
    await session.processing;
    this.dispatchSession(session.id);
    await session.processing;
    const status = session.attachmentStatus.get(id);
    if (status?.progress === false) throw new ProtocolError(500, status.error || "附件保存失败");
  }

  private dispatchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if ((session.pendingUploads && !session.items.every((item) => item.imported)) || session.processing) { this.scheduleDispatch(session); return; }
    for (const entry of session.attachmentStatus.values()) {
      if (!session.pendingUploads && entry.progress === 0 && !session.attachments.some((attachment) => attachment.id === entry.id)) {
        entry.progress = false;
        entry.error = "等待附件超时，稍后上传仍可补充";
      }
    }
    session.processing = this.importSession(session).finally(() => { session.processing = undefined; });
  }

  private async importSession(session: ConnectorSession): Promise<void> {
    for (const item of session.items) {
      if (this.sessions.get(session.id) !== session || item.error) continue;
      const matched = session.attachments.filter((attachment) => attachment.parentItemId === item.id && !item.delivered.has(attachment.id));
      if (item.imported && !matched.length) continue;
      try {
        if (!item.imported) {
          const docId = await this.options.onImport({ id: `${session.id}:${item.id}`, source: SOURCE.connector,
            canonical: canonicalFromRaw(item.raw), raw: item.raw, attachments: matched, sourceUrl: session.uri, sessionId: session.id });
          item.docId = docId || undefined;
          item.imported = true;
        } else {
          if (!item.docId || !this.options.onAdditionalAttachments) throw new Error("已保存文献无法接收迟到附件，请重新导入PDF");
          await this.options.onAdditionalAttachments(item.docId, matched);
        }
        for (const attachment of matched) session.attachmentStatus.get(attachment.id)!.progress = 100;
      } catch (error) {
        const message = errorMessage(error);
        if (!item.imported) item.error = message;
        for (const attachment of matched) Object.assign(session.attachmentStatus.get(attachment.id)!, { progress: false, error: message });
        this.options.onProtocolError?.(`论文「${string(item.raw.title)}」保存失败：${message}`);
      } finally {
        for (const attachment of matched) { item.delivered.add(attachment.id); this.removeTempFile(attachment.tempPath); }
        session.updatedAt = Date.now();
      }
    }
  }

  private async streamAttachment(
    request: IncomingMessage,
    metadata: ZoteroAttachmentMetadata,
  ): Promise<StoredAttachment> {
    const fs = requireNode<typeof import("node:fs")>("fs", this.requireFn);
    const path = requireNode<typeof import("node:path")>("path", this.requireFn);
    const stream = requireNode<typeof import("node:stream")>("stream", this.requireFn);
    fs.mkdirSync(this.options.tempDirectory, { recursive: true });
    const id = cleanId(metadata.id) || randomId();
    const filename = safeFilename(metadata.filename || metadata.title || "attachment", mimeExtension(metadata.contentType ?? metadata.mimeType));
    const tempPath = path.join(this.options.tempDirectory, `${randomId()}-${id}-${filename}`);
    try {
      await new Promise<void>((resolve, reject) => {
        stream.pipeline(request, fs.createWriteStream(tempPath), (error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      this.removeTempFile(tempPath);
      throw error;
    }
    return {
      id,
      connectorId: id,
      parentItemId: cleanId(metadata.parentItemID) || undefined,
      title: metadata.title || filename,
      mimeType: metadata.contentType || metadata.mimeType || "application/octet-stream",
      sourceUrl: string(metadata.url) || undefined,
      tempPath,
    };
  }

  private cleanupExpired(): void {
    const cutoff = Date.now() - (this.options.sessionTtlMs ?? CONNECTOR_SESSION_TTL_MS);
    for (const [id, session] of this.sessions) {
      if (!session.pendingUploads && !session.processing && session.updatedAt < cutoff) {
        if (session.timer) clearTimeout(session.timer);
        this.sessions.delete(id);
        for (const attachment of session.attachments) this.removeTempFile(attachment.tempPath);
      }
    }

  }

  private removeTempFile(pathname: string | undefined): void {
    if (!pathname) return;
    const fs = requireNode<typeof import("node:fs")>("fs", this.requireFn);
    try { fs.unlinkSync(pathname); } catch { /* system tmp cleanup is the final fallback */ }
  }

  private ensureTempDirectory(): void {
    const fs = requireNode<typeof import("node:fs")>("fs", this.requireFn);
    fs.mkdirSync(this.options.tempDirectory, { recursive: true });
  }

  private setCommonHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Metadata, X-Zotero-Version, X-Zotero-Connector-API-Version");
    response.setHeader("X-Zotero-Version", "7.0.0");
    response.setHeader("Access-Control-Expose-Headers", "X-Zotero-Version");
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Cache-Control", "no-store");
  }

  private respondJson(response: ServerResponse, status: number, payload: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new ProtocolError(413, `JSON 请求超过 ${maxBytes} 字节限制`);
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (!body.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { throw new ProtocolError(400, "Invalid JSON request body"); }
  if (!isRecord(parsed)) throw new ProtocolError(400, "JSON 请求体必须是对象");
  return parsed;
}

function attachmentMetadata(request: IncomingMessage): ZoteroAttachmentMetadata {
  const raw = header(request, "x-metadata");
  if (!raw) throw new ProtocolError(400, "X-Metadata header is required");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    const metadata = parsed as ZoteroAttachmentMetadata;
    if (metadata.title) metadata.title = decodeHeaderTitle(metadata.title);
    return metadata;
  } catch {
    throw new ProtocolError(400, "Invalid X-Metadata header");
  }
}

function expectedAttachmentCount(items: Record<string, unknown>[]): number {
  return items.reduce((total, item) => total + (Array.isArray(item.attachments) ? item.attachments.filter((a) => isRecord(a) && a.snapshot !== false && a.linkMode !== "linked_url").length : 0), 0);
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function itemId(raw: Record<string, unknown>, index: number): string {
  return cleanId(raw.id ?? raw.key ?? raw.itemID) || `item-${index + 1}`;
}

function cloneRecord(raw: Record<string, unknown>): Record<string, unknown> {
  try { return structuredClone(raw); } catch { return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>; }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanId(value: unknown): string {
  return string(value).replace(/[^\w.-]/g, "").slice(0, 200);
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeFilename(value: string, fallbackExtension: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "attachment";
  return /\.[a-z0-9]{1,8}$/i.test(clean) ? clean : `${clean}${fallbackExtension}`;
}

function mimeExtension(mime: unknown): string {
  switch (string(mime).toLowerCase()) {
    case "application/pdf": return ".pdf";
    case "text/html": return ".html";
    case "application/xhtml+xml": return ".xhtml";
    default: return ".bin";
  }
}

function connectorStartError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "EADDRINUSE") return "端口已被占用，请关闭 Zotero 或修改 Connector 端口";
    if (error.code === "EACCES") return "没有监听该端口的权限";
  }
  return error instanceof Error ? error.message : String(error);
}

class ProtocolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function decodeHeaderTitle(value: string): string {
  return value.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (original, encoding: string, body: string) => {
    try {
      if (encoding.toUpperCase() === "B") return Buffer.from(body, "base64").toString("utf8");
      return decodeURIComponent(body.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, "%$1"));
    } catch { return original; }
  });
}
