import { normalizeCnkiTimeout } from "../types/settings";
import type { EventEmitter } from "node:events";
import { Dialog } from "siyuan";
import { getNodeRequire, type NodeRequire } from "../core/env";
import { CnkiClient, trustedCnkiUrl, type CnkiRequest, type CnkiResponse, type CnkiTransport } from "./cnki-client";

interface WebContents extends EventEmitter {
  getURL(): string;
  getTitle(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}
interface VerificationWindow extends EventEmitter {
  webContents: WebContents;
  loadURL(url: string): Promise<void>;
  close(): void;
  isDestroyed(): boolean;
  focus(): void;
}
interface NetRequest extends EventEmitter { setHeader(name: string, value: string): void; write(body: string): void; end(): void; abort(): void; followRedirect(): void }
interface NetResponse extends EventEmitter { statusCode: number }
export interface CnkiElectron {
  session: { fromPartition(partition: string): { setPermissionRequestHandler(handler: (_webContents: unknown, _permission: string, callback: (allowed: boolean) => void) => void): void } };
  net: { request(options: Record<string, unknown>): NetRequest };
  BrowserWindow: new (options: Record<string, unknown>) => VerificationWindow;
}

/** Isolated, memory-only Electron session, shared by requests and the verification window. */
export class DesktopCnkiTransport implements CnkiTransport {
  private readonly session;
  private readonly pending = new Set<() => void>();
  private disposed = false;
  timeoutSeconds = 10;
  constructor(private readonly electron: CnkiElectron) {
    this.session = electron.session.fromPartition(`paper-manager-cnki-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }
  dispose(): void { this.disposed = true; for (const cancel of [...this.pending]) cancel(); }

  async request(input: CnkiRequest, signal?: AbortSignal): Promise<CnkiResponse> {
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await this.requestOnce(input, signal);
      if (![301, 302, 303, 307, 308].includes(response.status) || /\/(verify|captcha)(?:\/|\?)/i.test(response.url)) return response;
      const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && input.method === "POST");
      input = { ...input, url: response.url, ...(toGet ? { method: "GET", body: undefined } : {}) };
    }
    throw new Error("知网重定向次数过多");
  }

  private requestOnce(input: CnkiRequest, signal?: AbortSignal): Promise<CnkiResponse> {
    signal?.throwIfAborted();
    if (this.disposed) throw new DOMException("知网会话已关闭", "AbortError");
    return new Promise((resolve, reject) => {
      let finalUrl = trustedCnkiUrl(input.url);
      const request = this.electron.net.request({ url: finalUrl, method: input.method, session: this.session, useSessionCookies: true, redirect: "manual" });
      let settled = false;
      let stage = "等待响应头";
      let receivedBytes = 0;
      const finish = (error?: Error, response?: CnkiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(cancel);
        if (error) { request.abort(); reject(error); } else resolve(response!);
      };
      const cancel = () => finish(new DOMException("已取消知网检索", "AbortError"));
      const timeoutSeconds = normalizeCnkiTimeout(this.timeoutSeconds);
      const timer = setTimeout(() => finish(new Error(`知网请求超时（${timeoutSeconds}秒）：${new URL(input.url).pathname}（${stage}，已接收 ${receivedBytes} 字节）`)), timeoutSeconds * 1000);
      this.pending.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      request.on("redirect", (status: number, _method: string, url: string) => {
        // remote callbacks run asynchronously: followRedirect must not be called here.
        try {
          finalUrl = trustedCnkiUrl(url);
          finish(undefined, { status, url: finalUrl, text: "" });
          request.abort();
        } catch (error) { finish(error as Error); }
      });
      request.on("error", (error: Error) => finish(error));
      request.on("response", (response: NetResponse) => {
        stage = `HTTP ${response.statusCode}，等待响应结束`;
        const chunks: Uint8Array[] = [];
        let length = 0;
        response.on("error", (error: Error) => finish(error));
        response.on("aborted", () => finish(new Error("知网响应传输中断")));
        response.on("end", () => {
          if (settled) return;
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          finish(undefined, { status: response.statusCode, url: finalUrl, text: new TextDecoder().decode(bytes) });
        });
        // Register terminal events before data starts the remote stream flowing.
        response.on("data", (chunk: Uint8Array) => {
          length += chunk.length;
          receivedBytes = length;
          if (length > 8 * 1024 * 1024) { finish(new Error("知网响应过大")); return; }
          chunks.push(new Uint8Array(chunk));
        });
      });
      try {
        for (const [name, value] of Object.entries(input.headers)) request.setHeader(name, value);
        if (input.body) request.write(input.body);
        request.end();
      } catch (error) { finish(error as Error); }
    });
  }

  verify(url: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.disposed) throw new DOMException("知网会话已关闭", "AbortError");
    url = trustedCnkiUrl(url);
    return new Promise((resolve, reject) => {
      const win = new this.electron.BrowserWindow({
        width: 1100, height: 800, title: "知网验证 · 成功后自动继续检索", autoHideMenuBar: true,
        webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      let settled = false;
      let verificationSeen = /\/(verify|captcha)(?:\/|\?)/i.test(url);
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(retryTimer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(cancel);
        if (!win.isDestroyed()) win.close();
        dialog?.destroy();
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new DOMException("已取消知网验证；本地候选仍可使用", "AbortError"));
      this.pending.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      win.on("closed", cancel);
      win.webContents.on("did-navigate", (_event: unknown, target: string) => {
        if (/\/(verify|captcha)(?:\/|\?)/i.test(target)) verificationSeen = true;
      });
      win.webContents.on("did-finish-load", () => {
        if (settled || win.isDestroyed()) return;
        const target = win.webContents.getURL();
        try { trustedCnkiUrl(target); } catch { return; }
        const challenged = /\/(verify|captcha)(?:\/|\?)/i.test(target) || /验证|captcha/i.test(win.webContents.getTitle());
        if (challenged) { verificationSeen = true; return; }
        // Only a successfully loaded CNKI landing/search page completes verification.
        const path = new URL(target).pathname;
        if (/^(?:\/|\/(?:kns8s|kns)\/defaultresult\/index|\/index(?:\.html?)?)$/i.test(path)
          && (verificationSeen || target === url)) finish();
      });
      win.webContents.on("will-navigate", (event: { preventDefault(): void }, target: string) => {
        try { trustedCnkiUrl(target); } catch { event.preventDefault(); }
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const dialog = new Dialog({ title: "知网检索验证", width: "480px",
        content: `<div class="b3-dialog__content paper-manager-dialog"><div class="paper-manager-dialog-scroll"><p class="paper-manager-hint">请在知网窗口中等待页面加载，并手动完成验证码（如有）。验证成功并跳转至知网页面后，窗口会自动关闭并继续检索；未自动继续时可使用下方按钮。</p><p data-cnki-status>正在加载知网页面…</p></div><div class="paper-manager-dialog-footer"><div class="paper-manager-actions"><button class="b3-button" data-cnki-continue disabled>验证完成，继续检索</button><button class="b3-button b3-button--outline" data-cnki-retry>重新加载</button><button class="b3-button b3-button--outline" data-cnki-focus>显示知网窗口</button><button class="b3-button b3-button--outline" data-cnki-cancel>跳过在线检索</button></div></div></div>`,
        destroyCallback: cancel,
      });
      dialog.element.querySelector<HTMLButtonElement>("[data-cnki-continue]")!.onclick = () => finish();
      dialog.element.querySelector<HTMLButtonElement>("[data-cnki-focus]")!.onclick = () => { if (!win.isDestroyed()) win.focus(); };
      dialog.element.querySelector<HTMLButtonElement>("[data-cnki-cancel]")!.onclick = cancel;
      const status = dialog.element.querySelector<HTMLElement>("[data-cnki-status]")!;
      const proceed = dialog.element.querySelector<HTMLButtonElement>("[data-cnki-continue]")!;
      const retry = dialog.element.querySelector<HTMLButtonElement>("[data-cnki-retry]")!;
      const load = async (attempt = 0): Promise<void> => {
        if (settled || win.isDestroyed()) return;
        clearTimeout(retryTimer);
        proceed.disabled = true;
        retry.disabled = true;
        status.textContent = attempt ? `连接中断，正在自动重试（${attempt}/2）…` : "正在加载知网页面…";
        try {
          await win.loadURL(url);
          if (settled) return;
          proceed.disabled = false;
          retry.disabled = false;
          status.textContent = "页面已加载。请完成验证后点击继续检索。";
        } catch (error) {
          if (settled) return;
          const detail = error instanceof Error ? error.message : String(error);
          if (/ERR_SSL_BAD_RECORD_MAC_ALERT|ERR_CONNECTION_(?:RESET|CLOSED|ABORTED)|ERR_TIMED_OUT|ERR_NETWORK_CHANGED/.test(detail) && attempt < 2) {
            status.textContent = `连接暂时失败，将自动重试（${attempt + 1}/2）：${detail}`;
            retryTimer = setTimeout(() => { void load(attempt + 1); }, 1000 * (attempt + 1));
          } else {
            retry.disabled = false;
            status.textContent = `页面加载失败：${detail}。窗口已保留，可点击「重新加载」，或跳过在线检索。`;
          }
        }
      };
      retry.onclick = () => { void load(); };
      void load();
    });
  }
}
let shared: { client: CnkiClient; transport: DesktopCnkiTransport } | undefined;
export function desktopCnkiClient(requireFn: NodeRequire | null = getNodeRequire(), timeoutSeconds = 10): CnkiClient {
  if (shared) { shared.transport.timeoutSeconds = normalizeCnkiTimeout(timeoutSeconds); return shared.client; }
  if (!requireFn) throw new Error("知网在线检索需要思源桌面端；浏览器端仍可使用 PDF 本地识别");
  let electron: CnkiElectron;
  try { electron = requireFn("@electron/remote") as CnkiElectron; }
  catch { throw new Error("当前思源桌面端未提供知网检索所需的 Electron 会话接口"); }
  const transport = new DesktopCnkiTransport(electron);
  transport.timeoutSeconds = normalizeCnkiTimeout(timeoutSeconds);
  shared = { client: new CnkiClient(transport), transport };
  return shared.client;
}
export function disposeCnkiClient(): void { shared?.transport.dispose(); shared = undefined; }
