import type { EventEmitter } from "node:events";
import { getNodeRequire } from "../core/env";
interface Request extends EventEmitter { setHeader(name: string, value: string): void; write(body: string): void; end(): void; abort(): void }
interface Incoming extends EventEmitter { statusCode: number; headers: Record<string, string | string[]> }
interface Net { request(options: Record<string, unknown>): Request }

/** AbortSignal cannot cross @electron/remote; bridge cancellation with request.abort(). */
const desktopMetadataFetch: typeof fetch = async (input, init) => {
  const require = getNodeRequire();
  let net: Net | undefined;
  try { net = (require?.("@electron/remote") as { net?: Net } | undefined)?.net; } catch { /* browser frontend */ }
  if (!net) return globalThis.fetch(input, init);
  init?.signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const request = net!.request({ url: String(input), method: init?.method ?? "GET", credentials: "omit", useSessionCookies: false });
    let settled = false;
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      init?.signal?.removeEventListener("abort", cancel);
      if (error) { request.abort(); reject(error); } else resolve(response!);
    };
    const cancel = () => finish(new DOMException("已取消检索", "AbortError"));
    init?.signal?.addEventListener("abort", cancel, { once: true });
    request.on("error", (error: Error) => finish(error));
    request.on("response", (response: Incoming) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      response.on("error", (error: Error) => finish(error));
      response.on("aborted", () => finish(new Error("元数据响应连接中断")));
      response.on("end", () => {
        if (settled) return;
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        finish(undefined, new Response([204, 205, 304].includes(response.statusCode) ? null : data, { status: response.statusCode, headers }));
      });
      // Terminal listeners must cross remote IPC before data starts the stream.
      response.on("data", (chunk: Uint8Array) => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) { finish(new Error("元数据响应超过 8 MiB")); return; }
        chunks.push(new Uint8Array(chunk));
      });
    });
    new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    if (typeof init?.body === "string") request.write(init.body);
    request.end();
  });
};


/** Only retry the official recognizer on a different DNS address after a connection failure. */
export const metadataFetch: typeof fetch = async (input, init) => {
  try { return await desktopMetadataFetch(input, init); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const require = getNodeRequire();
    if (String(input) !== "https://services.zotero.org/recognizer/recognize" || !require
      || !/ERR_CONNECTION_RESET|ECONNRESET|ERR_CONNECTION_CLOSED/.test(String(error))) throw error;
    const dns = require("node:dns") as typeof import("node:dns");
    const https = require("node:https") as typeof import("node:https");
    const addresses = await dns.promises.lookup("services.zotero.org", { all: true });
    let lastError = error;
    for (const address of addresses.slice(0, 4)) {
      init?.signal?.throwIfAborted();
      try {
        return await new Promise<Response>((resolve, reject) => {
          // Keep the hostname/SNI and normal certificate validation; never pin a CDN IP.
          const request = https.request(String(input), {
            method: init?.method ?? "GET", agent: false, signal: init?.signal ?? undefined,
            headers: Object.fromEntries(new Headers(init?.headers)),
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [address]);
              else callback(null, address.address, address.family);
            },
          }, response => {
            const chunks: Uint8Array[] = [];
            let length = 0;
            response.on("error", reject);
            response.on("aborted", () => reject(new Error("Zotero 响应连接中断")));
            response.on("end", () => {
              const data = new Uint8Array(length);
              let offset = 0;
              for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
              }
              resolve(new Response(data, { status: response.statusCode ?? 502, headers }));
            });
            response.on("data", (chunk: Uint8Array) => {
              length += chunk.length;
              if (length > 8 * 1024 * 1024) { request.destroy(new Error("元数据响应超过 8 MiB")); return; }
              chunks.push(new Uint8Array(chunk));
            });
          });
          request.on("error", reject);
          request.end(typeof init?.body === "string" ? init.body : undefined);
        });
      } catch (retryError) {
        init?.signal?.throwIfAborted();
        if (!/ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|连接中断/.test(String(retryError))) throw retryError;
        lastError = retryError;
      }
    }
    throw lastError;
  }
};
