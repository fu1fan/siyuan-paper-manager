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
  timer?: ReturnType<typeof setTimeout>;
}

export interface ConnectorServerOptions {
  port: number;
  tempDirectory: string;
  requireFn?: NodeRequire;
  onImport: (candidate: ImportCandidate) => void | Promise<void>;
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
  private readonly completedSessions = new Map<string, number>();
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
        if (!response.headersSent) this.respondJson(response, 500, { error: message });
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
      for (const attachment of session.attachments) this.removeTempFile(attachment.tempPath);
    }
    this.sessions.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      case "/connector/saveAttachment":
      case "/connector/saveSingleFile":
        await this.handleAttachment(request, response, url);
        return;
      case "/connector/saveStandaloneAttachment":
        await this.handleStandaloneAttachment(request, response);
        return;
      case "/connector/sessionProgress":
        this.handleSessionProgress(response, url);
        return;
      case "/connector/getSelectedCollection":
        this.respondJson(response, 200, {
          editable: true,
          id: "siyuan-paper-manager",
          name: "SiYuan Paper Manager",
          libraryID: 1,
          libraryName: "SiYuan",
          filesEditable: true,
        });
        return;
      case "/connector/updateSession":
      case "/connector/delaySync":
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
        translatorsHash: "siyuan-paper-manager-v1",
        sortedTranslatorHash: "siyuan-paper-manager-v1-sorted",
      },
      version: "SiYuan Paper Manager 0.3.0",
    });
  }

  private async handleSaveItems(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await readJson(request, MAX_JSON_BODY_BYTES);
    const items = Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
    if (!items.length) {
      this.respondJson(response, 400, { error: "items is required" });
      return;
    }
    const sessionId = cleanId(payload.sessionID) || randomId();
    if (this.completedSessions.has(sessionId)) {
      this.respondJson(response, 201, { sessionID: sessionId });
      return;
    }
    const now = Date.now();
    const session: ConnectorSession = {
      id: sessionId,
      uri: string(payload.uri) || undefined,
      items: items.map((raw, index) => ({ id: itemId(raw, index), raw: cloneRecord(raw) })),
      attachments: [],
      createdAt: now,
      updatedAt: now,
      expectedAttachments: expectedAttachmentCount(items),
    };
    this.sessions.set(sessionId, session);
    this.scheduleDispatch(session, session.expectedAttachments ? this.options.attachmentWaitMs ?? 5 * 60_000 : undefined);
    this.respondJson(response, 201, { sessionID: sessionId });
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
    const sessionId = cleanId(payload.sessionID) || randomId();
    const now = Date.now();
    const session: ConnectorSession = {
      id: sessionId,
      uri: string(payload.uri ?? payload.url) || undefined,
      items: rawItems.map((raw, index) => ({ id: itemId(raw, index), raw: cloneRecord(raw) })),
      attachments: [],
      createdAt: now,
      updatedAt: now,
      expectedAttachments: expectedAttachmentCount(rawItems),
    };
    this.sessions.set(sessionId, session);
    this.scheduleDispatch(session, session.expectedAttachments ? this.options.attachmentWaitMs ?? 5 * 60_000 : undefined);
    this.respondJson(response, 201, { sessionID: sessionId });
  }

  private async handleAttachment(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const sessionId = cleanId(url.searchParams.get("sessionID") ?? url.searchParams.get("session"));
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.respondJson(response, 404, { error: `unknown session: ${sessionId}` });
      return;
    }
    const metadata = attachmentMetadata(request);
    const attachment = await this.streamAttachment(request, metadata);
    const existing = session.attachments.find((item) => item.id === attachment.id);
    if (!existing) session.attachments.push(attachment);
    session.updatedAt = Date.now();
    if (session.attachments.length >= session.expectedAttachments) this.scheduleDispatch(session);
    this.respondJson(response, 200, { id: attachment.id, progress: 100 });
  }

  private async handleStandaloneAttachment(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const metadata = attachmentMetadata(request);
    const attachment = await this.streamAttachment(request, metadata);
    const raw: Record<string, unknown> = {
      itemType: "attachment",
      title: metadata.title || metadata.filename || "独立附件",
      url: metadata.url,
    };
    this.emitCandidate({
      id: attachment.id,
      source: SOURCE.connector,
      canonical: canonicalFromRaw(raw),
      raw,
      attachments: [attachment],
    });
    this.respondJson(response, 201, { id: attachment.id, progress: 100 });
  }

  private handleSessionProgress(response: ServerResponse, url: URL): void {
    const id = cleanId(url.searchParams.get("sessionID") ?? url.searchParams.get("session"));
    const session = this.sessions.get(id);
    if (!session) {
      this.respondJson(response, 200, { done: this.completedSessions.has(id), items: [] });
      return;
    }
    this.respondJson(response, 200, {
      done: false,
      items: session.items.map((item) => ({ id: item.id, progress: attachmentProgress(session, item) })),
    });
  }

  private scheduleDispatch(session: ConnectorSession, delayMs?: number): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(
      () => this.dispatchSession(session.id),
      delayMs ?? this.options.graceMs ?? CONNECTOR_GRACE_MS,
    );
  }

  private dispatchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.completedSessions.set(sessionId, Date.now());
    for (const item of session.items) {
      const matched = session.attachments.filter((attachment) =>
        attachment.parentItemId === item.id || (!attachment.parentItemId && session.items.length === 1));
      this.emitCandidate({
        id: `${sessionId}:${item.id}`,
        source: SOURCE.connector,
        canonical: canonicalFromRaw(item.raw),
        raw: item.raw,
        attachments: matched,
        sourceUrl: session.uri,
        sessionId,
      });
    }
  }

  private emitCandidate(candidate: ImportCandidate): void {
    void Promise.resolve(this.options.onImport(candidate)).catch((error) => {
      this.options.onProtocolError?.(error instanceof Error ? error.message : String(error));
    });
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
    const tempPath = path.join(this.options.tempDirectory, `${Date.now()}-${id}-${filename}`);
    await new Promise<void>((resolve, reject) => {
      stream.pipeline(request, fs.createWriteStream(tempPath), (error) => error ? reject(error) : resolve());
    });
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
      if (session.updatedAt < cutoff) {
        if (session.timer) clearTimeout(session.timer);
        this.sessions.delete(id);
        for (const attachment of session.attachments) this.removeTempFile(attachment.tempPath);
      }
    }
    for (const [id, completedAt] of this.completedSessions) {
      if (completedAt < cutoff) this.completedSessions.delete(id);
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
    if (size > maxBytes) throw new Error(`JSON 请求超过 ${maxBytes} 字节限制`);
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (!body.length) return {};
  const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (!isRecord(parsed)) throw new Error("JSON 请求体必须是对象");
  return parsed;
}

function attachmentMetadata(request: IncomingMessage): ZoteroAttachmentMetadata {
  const raw = header(request, "x-metadata");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed as ZoteroAttachmentMetadata : {};
  } catch {
    return {};
  }
}

function attachmentProgress(session: ConnectorSession, item: ConnectorItem): number {
  const expected = Array.isArray(item.raw.attachments) ? item.raw.attachments.length : 0;
  const completed = session.attachments.filter((attachment) => attachment.parentItemId === item.id).length;
  return expected ? Math.min(100, Math.round((completed / expected) * 100)) : completed ? 100 : 0;
}

function expectedAttachmentCount(items: Record<string, unknown>[]): number {
  return items.reduce((total, item) => total + (Array.isArray(item.attachments) ? item.attachments.length : 0), 0);
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
