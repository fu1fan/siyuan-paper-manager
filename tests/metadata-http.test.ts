import { EventEmitter } from "node:events";
import { metadataFetch } from "../src/services/metadata-http";
it("bridges desktop cancellation without sending AbortSignal over Electron remote", async () => {
  const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() });
  const factory = vi.fn().mockReturnValue(request);
  vi.stubGlobal("require", () => ({ net: { request: factory } }));
  try {
    const controller = new AbortController();
    const pending = metadataFetch("https://example.org", { signal: controller.signal });
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    controller.abort();
    await expect(pending).rejects.toThrow("已取消");
    expect(request.abort).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
it("returns a browser Response from native chunks", async () => {
  const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() });
  vi.stubGlobal("require", () => ({ net: { request: () => request } }));
  try {
    const pending = metadataFetch("https://example.org");
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": ["application/json"] } });
    request.emit("response", incoming);
    incoming.emit("data", new TextEncoder().encode('{"title":"Example"}')); incoming.emit("end");
    expect(await (await pending).json()).toEqual({ title: "Example" });
  } finally { vi.unstubAllGlobals(); }
});
it("registers terminal listeners before a remote stream can finish synchronously", async () => {
  const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() });
  vi.stubGlobal("require", () => ({ net: { request: () => request } }));
  try {
    const pending = metadataFetch("https://example.org");
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const on = incoming.on;
    incoming.on = function (event, listener) {
      on.call(this, event, listener);
      if (event === "data") { this.emit("data", new TextEncoder().encode("complete")); this.emit("end"); }
      return this;
    };
    request.emit("response", incoming);
    expect(await (await pending).text()).toBe("complete");
  } finally { vi.unstubAllGlobals(); }
});

it("fails over official Zotero DNS addresses without changing TLS hostname or sharing cancellation", async () => {
  const native = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(), write: vi.fn(), abort: vi.fn(),
    end() { queueMicrotask(() => native.emit("error", new Error("net::ERR_CONNECTION_RESET"))); },
  });
  const lookup = vi.fn().mockResolvedValue([{ address: "192.0.2.1", family: 4 }, { address: "192.0.2.2", family: 4 }]);
  const urls: string[] = [];
  const options: any[] = [];
  const nodeRequest = vi.fn((url, opts, respond) => {
    urls.push(url); options.push(opts);
    const index = options.length;
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end() {
        queueMicrotask(() => {
          if (index === 1) { req.emit("error", new Error("read ECONNRESET")); return; }
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
          respond(response);
          response.emit("data", new TextEncoder().encode('{"title":"Recovered"}'));
          response.emit("end");
        });
      },
    });
    return req;
  });
  vi.stubGlobal("require", (id: string) => id === "node:dns" ? { promises: { lookup } }
    : id === "node:https" ? { request: nodeRequest } : { net: { request: () => native } });
  try {
    const signal = new AbortController().signal;
    const url = "https://services.zotero.org/recognizer/recognize";
    expect(await (await metadataFetch(url, { method: "POST", body: "{}", signal })).json()).toEqual({ title: "Recovered" });
    expect(urls).toEqual([url, url]);
    for (const opts of options) { expect(opts.signal).toBe(signal); expect(opts).not.toHaveProperty("rejectUnauthorized"); }
    const resolved = vi.fn(); options[1].lookup("services.zotero.org", { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: "192.0.2.2", family: 4 }]);
  } finally { vi.unstubAllGlobals(); }
});

it("does not send other metadata hosts through the Zotero fallback", async () => {
  const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn() });
  const require = vi.fn(() => ({ net: { request: () => request } }));
  vi.stubGlobal("require", require);
  try {
    const pending = metadataFetch("https://api.crossref.org/works");
    request.emit("error", new Error("net::ERR_CONNECTION_RESET"));
    await expect(pending).rejects.toThrow("ERR_CONNECTION_RESET");
    expect(require).not.toHaveBeenCalledWith("node:https");
  } finally { vi.unstubAllGlobals(); }
});
