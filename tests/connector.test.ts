import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorServer } from "../src/server/connector-server";
import type { ImportCandidate } from "../src/types/import";

describe("ConnectorServer", () => {
  let connector: ConnectorServer | null = null;
  let directory = "";
  let base = "";

  afterEach(async () => {
    await connector?.stop();
    connector = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Start a connector for one test.  A port obtained from `freePort()` can be
   * taken before the connector binds it, so retry on conflict rather than
   * failing the run.
   */
  async function boot(prefix: string, options: Omit<ConstructorParameters<typeof ConnectorServer>[0], "port" | "tempDirectory">): Promise<ConnectorServer> {
    directory = mkdtempSync(join(tmpdir(), prefix));
    for (let attempt = 0; ; attempt += 1) {
      const port = await freePort();
      const instance = new ConnectorServer({ ...options, port, tempDirectory: directory });
      try {
        await instance.start();
        connector = instance;
        base = `http://127.0.0.1:${port}`;
        return instance;
      } catch (error) {
        if (attempt >= 3 || !/EADDRINUSE|端口已被占用/.test(String(error))) throw error;
      }
    }
  }

  it("rejects website origins and DNS rebinding hosts while accepting extension and originless clients", async () => {
    const onImport = vi.fn();
    await boot("connector-origin-", { requireFn: createRequire(import.meta.url), onImport });
    const endpoint = `${base}/connector/saveItems`;
    const body = JSON.stringify({ sessionID: "safe", items: [{ id: "paper", title: "Paper" }] });
    const website = await fetch(endpoint, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body });
    expect(website.status).toBe(403);
    expect(website.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/connector/sessionProgress`, { method: "POST", body: JSON.stringify({ sessionID: "safe" }) })).status).toBe(404);
    expect((await fetch(endpoint, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body })).status).toBe(403);
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(endpoint, { method: "POST", headers: { Host: `evil.example:${new URL(base).port}`, "Content-Type": "application/json" } },
        (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end(body);
    });
    expect(rebindingStatus).toBe(403);
    const extension = await fetch(`${base}/connector/ping`, { method: "POST", headers: { Origin: "chrome-extension://abcdefghijklmnop" } });
    expect(extension.status).toBe(200);
    expect(extension.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
    expect((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(201);
  });

  it("limits streamed attachment bytes, aggregate session bytes, and concurrent uploads", async () => {
    await boot("connector-limits-", { requireFn: createRequire(import.meta.url), onImport: () => "doc",
      maxAttachmentBytes: 8, maxSessionBytes: 12, maxConcurrentUploads: 1, graceMs: 1000 });
    const save = await fetch(`${base}/connector/saveItems`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "limited", items: [{ id: "paper", title: "Paper", attachments: [{ id: "a" }, { id: "b" }] }] }) });
    expect(save.status).toBe(201);
    const upload = (id: string, body: string) => fetch(`${base}/connector/saveAttachment?sessionID=limited`, {
      method: "POST", headers: { "X-Metadata": JSON.stringify({ id, parentItemID: "paper" }) }, body,
    });
    expect((await upload("large", "123456789")).status).toBe(413);
    expect(readdirSync(directory)).toHaveLength(0);
    expect((await upload("a", "12345678")).status).toBe(201);
    expect((await upload("b", "12345")).status).toBe(413);
    expect(readdirSync(directory)).toHaveLength(1);

    let pending!: ReturnType<typeof httpRequest>;
    const finished = new Promise<number | undefined>((resolve, reject) => {
      pending = httpRequest(`${base}/connector/saveAttachment?sessionID=limited`, {
        method: "POST", headers: { "X-Metadata": JSON.stringify({ id: "slow", parentItemID: "paper" }) },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      pending.on("error", reject);
      pending.write("x");
    });
    await vi.waitFor(async () => {
      const progress = await (await fetch(`${base}/connector/sessionProgress`, { method: "POST", body: JSON.stringify({ sessionID: "limited" }) })).json();
      expect(progress.items[0].attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: "slow" })]));
    });
    expect((await upload("parallel", "x")).status).toBe(429);
    pending.end();
    expect(await finished).toBe(201);
  });

  it("applies the session quota to JSON SingleFile snapshots", async () => {
    await boot("connector-snapshot-limit-", { requireFn: createRequire(import.meta.url), onImport: () => "doc",
      maxAttachmentBytes: 1024, maxSessionBytes: 10 });
    expect((await fetch(`${base}/connector/saveItems`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "snapshot-limit", items: [{ id: "paper", title: "Paper" }] }) })).status).toBe(201);
    const snapshot = { sessionID: "snapshot-limit", snapshotContent: "12345678901" };
    expect((await fetch(`${base}/connector/saveSingleFile`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot) })).status).toBe(413);
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it("limits cumulative uploads across sessions", async () => {
    await boot("connector-global-limit-", { requireFn: createRequire(import.meta.url), onImport: () => "doc",
      maxAttachmentBytes: 8, maxSessionBytes: 12, maxTotalAttachmentBytes: 12 });
    for (const id of ["one", "two"]) {
      expect((await fetch(`${base}/connector/saveItems`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID: id, items: [{ id: "paper", title: "Paper" }] }) })).status).toBe(201);
    }
    const upload = (session: string, body: string) => fetch(`${base}/connector/saveAttachment?sessionID=${session}`, {
      method: "POST", headers: { "X-Metadata": JSON.stringify({ id: "pdf", parentItemID: "paper" }) }, body,
    });
    expect((await upload("one", "12345678")).status).toBe(201);
    expect((await upload("two", "12345")).status).toBe(429);
  });

  it("implements ping, version checks, multi-item attachment mapping, and 501", async () => {
    const received: ImportCandidate[] = [];
    await boot("paper-manager-connector-test-", {
      requireFn: createRequire(import.meta.url),
      graceMs: 30,
      onImport: (candidate) => { received.push(candidate); },
    });
    const ping = await fetch(`${base}/connector/ping`, { method: "POST" });
    expect(ping.status).toBe(200);
    const prefs = (await ping.json()).prefs;
    expect(prefs.supportsAttachmentUpload).toBe(true);
    expect(prefs.translatorsHash).toBeUndefined();

    const tooNew = await fetch(`${base}/connector/ping`, {
      method: "POST",
      headers: { "X-Zotero-Connector-API-Version": "99" },
    });
    expect(tooNew.status).toBe(412);

    const sessionID = "test-session";
    const saved = await fetch(`${base}/connector/saveItems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID,
        uri: "https://example.com/source",
        items: [
          { id: "item-a", itemType: "journalArticle", title: "Paper A", creators: [], attachments: [{ id: "att-a" }] },
          { id: "item-b", itemType: "journalArticle", title: "Paper B", creators: [] },
        ],
      }),
    });
    expect(saved.status).toBe(201);
    const attachment = await fetch(`${base}/connector/saveAttachment?sessionID=${sessionID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Metadata": JSON.stringify({ id: "att-a", parentItemID: "item-a", title: "paper.pdf", contentType: "application/pdf" }),
      },
      body: new Uint8Array([37, 80, 68, 70, 45]),
    });
    expect(attachment.status).toBe(201);
    // Wait for the deterministic outcome rather than racing a fixed sleep.
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.find((item) => item.canonical.title === "Paper A")?.attachments).toHaveLength(1);
    expect(received.find((item) => item.canonical.title === "Paper B")?.attachments).toHaveLength(0);

    const unsupported = await fetch(`${base}/connector/installStyle`, { method: "POST" });
    expect(unsupported.status).toBe(501);
  }, 10_000);

  it.each(["saveItems", "saveSnapshot"])("keeps attachments when %s and uploads are retried", async (route) => {
    const received: ImportCandidate[] = [];
    await boot("paper-manager-retry-test-", {
      requireFn: createRequire(import.meta.url), graceMs: 30,
      onImport: (candidate) => { received.push(candidate); },
    });
    const save = () => fetch(`${base}/connector/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "retry", items: [{ id: "paper", title: "Paper", attachments: [{ id: "a" }, { id: "b" }] }] }),
    });
    const upload = (id: string, body: string) => fetch(`${base}/connector/saveAttachment?sessionID=retry`, {
      method: "POST", headers: { "X-Metadata": JSON.stringify({ id, parentItemID: "paper", title: "paper.pdf" }) }, body,
    });
    const progress = () => fetch(`${base}/connector/sessionProgress`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: "retry" }),
    }).then((response) => response.json());
    await save();
    await upload("a", "original");
    await save();
    await upload("a", "duplicate");
    expect(readdirSync(directory)).toHaveLength(1);
    expect(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")).toBe("original");
    await upload("b", "second");
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.attachments).toHaveLength(2);
    // Idempotent re-save must not import again; wait for quiescence.
    await save();
    await vi.waitFor(async () => expect((await progress()).done).toBe(true));
    expect(received).toHaveLength(1);
  });

  it("does not dispatch a session while its attachment is still streaming", async () => {
    const received: ImportCandidate[] = [];
    await boot("paper-manager-stream-test-", {
      requireFn: createRequire(import.meta.url),
      graceMs: 20, attachmentWaitMs: 40, onImport: (candidate) => { received.push(candidate); },
    });
    await fetch(`${base}/connector/saveItems`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "slow", items: [{ id: "paper", title: "Paper", attachments: [{ id: "a" }] }] }),
    });
    let request!: ReturnType<typeof httpRequest>;
    const finished = new Promise<number | undefined>((resolve, reject) => {
      request = httpRequest(`${base}/connector/saveAttachment?sessionID=slow`, {
        method: "POST", headers: { "X-Metadata": JSON.stringify({ id: "a", parentItemID: "paper", title: "paper.pdf" }) },
      }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.write("first chunk");
    });
    // Confirm the server registered the in-flight upload, then that nothing was
    // dispatched.  Deterministic where a fixed sleep only probed timing.
    await vi.waitFor(async () => {
      const progress = await (await fetch(`${base}/connector/sessionProgress`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionID: "slow" }),
      })).json();
      expect(progress.done).toBe(false);
      expect(progress.items[0].attachments).toHaveLength(1);
    });
    expect(received).toHaveLength(0);
    request.end("last chunk");
    expect(await finished).toBe(201);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.attachments).toHaveLength(1);
  });

  /** Boot a session-scoped helper set for the protocol tests. */
  async function bootProtocol(onImport: (candidate: ImportCandidate) => string | void | Promise<string | void>,
    onAdditionalAttachments?: (docId: string, attachments: ImportCandidate["attachments"]) => Promise<void>) {
    await boot("connector-protocol-", {
      requireFn: createRequire(import.meta.url),
      graceMs: 15, attachmentWaitMs: 50, onImport, onAdditionalAttachments, onProtocolError: vi.fn(),
    });
    const prefix = `${base}/connector/`;
    const post = (route: string, data: unknown) => fetch(`${prefix}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const upload = (session: string, id: string, parentItemID: string, content = "%PDF-1.4 test", title = "Full Text PDF") => fetch(`${prefix}saveAttachment?sessionID=${session}`, {
      method: "POST", headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify({ id, parentItemID, title, contentType: "application/pdf" }) }, body: content,
    });
    /** Resolves once the session has no pending uploads or imports left to run. */
    const settle = async (sessionID: string) => {
      await vi.waitFor(async () => expect((await (await post("sessionProgress", { sessionID })).json()).done).toBe(true));
    };
    return { post, upload, settle };
  }

  it("matches modern Connector saves: late PDFs attach to the original document and retries are idempotent", async () => {
    const onImport = vi.fn(async () => "doc-arxiv");
    const late = vi.fn(async (docId: string, attachments: ImportCandidate["attachments"]) => {
      expect(docId).toBe("doc-arxiv");
      expect(readFileSync(attachments[0]!.tempPath!, "utf8")).toContain("%PDF-");
      expect(attachments[0]?.title).toBe("中文全文 PDF");
    });
    const { post, upload, settle } = await bootProtocol(onImport, late);
    // Current Connector removes downloaded attachments from the saveItems payload.
    const save = { sessionID: "arxiv", items: [{ id: "paper", title: "Can Large Language Models Anticipate Behavior?", attachments: [] }] };
    expect((await post("saveItems", save)).status).toBe(201);
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const pending = await (await post("sessionProgress", { sessionID: "arxiv" })).json();
    expect(pending.items[0].progress).toBe(100);
    const title = "=?UTF-8?Q?=E4=B8=AD=E6=96=87=E5=85=A8=E6=96=87_PDF?=";
    expect((await upload("arxiv", "pdf", "paper", "%PDF-1.4", title)).status).toBe(201);
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1));
    const progress = await (await post("sessionProgress", { sessionID: "arxiv" })).json();
    expect(progress).toMatchObject({ done: true, items: [{ id: "paper", progress: 100, attachments: [{ id: "pdf", progress: 100 }] }] });
    await post("saveItems", save);
    expect((await upload("arxiv", "pdf", "paper")).status).toBe(201);
    await settle("arxiv");
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect((await (await post("hasAttachmentResolvers", { sessionID: "arxiv", itemID: "paper" })).json())).toBe(false);
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it("routes late attachments in a multi-item save and rejects ambiguous parents", async () => {
    const onImport = vi.fn(async (candidate: ImportCandidate) => `doc-${candidate.canonical.title}`);
    const late = vi.fn(async () => {});
    const { post, upload } = await bootProtocol(onImport, late);
    await post("saveItems", { sessionID: "multi", items: [{ id: "a", title: "A", attachments: [] }, { id: "b", title: "B", attachments: [] }] });
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect((await upload("multi", "pdf", "")).status).toBe(400);
    expect((await upload("multi", "pdf", "b")).status).toBe(201);
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith("doc-B", expect.arrayContaining([expect.objectContaining({ parentItemId: "b" })])));
  });

  it("accepts JSON SingleFile snapshots and deduplicates retries", async () => {
    const onImport = vi.fn(async () => "doc-web");
    const late = vi.fn(async (_doc: string, attachments: ImportCandidate["attachments"]) => {
      expect(attachments[0]?.mimeType).toBe("text/html");
      expect(readFileSync(attachments[0]!.tempPath!, "utf8")).toBe("<!doctype html><p>中文页面</p>");
    });
    const { post, settle } = await bootProtocol(onImport, late);
    await post("saveSnapshot", { sessionID: "web", url: "https://example.org/", title: "网页" });
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const snapshot = { sessionID: "web", snapshotContent: "<!doctype html><p>中文页面</p>", url: "https://example.org/", title: "Snapshot" };
    expect((await post("saveSingleFile", snapshot)).status).toBe(204);
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1));
    expect((await post("saveSingleFile", snapshot)).status).toBe(204);
    await settle("web");
    expect(late).toHaveBeenCalledTimes(1);
    expect((await (await post("sessionProgress", { sessionID: "web" })).json()).done).toBe(true);
  });

  it("reports persistence failure instead of claiming success", async () => {
    const { post } = await bootProtocol(async () => { throw new Error("database write failed"); });
    await post("saveItems", { sessionID: "fail", items: [{ id: "paper", title: "Paper" }] });
    await vi.waitFor(async () => {
      const progress = await (await post("sessionProgress", { sessionID: "fail" })).json();
      expect(progress.items[0]).toMatchObject({ progress: false, error: "database write failed" });
    });
    expect((await post("sessionProgress", { sessionID: "missing" })).status).toBe(404);
  });

  it("returns an error on late persistence failure and permits an idempotent retry", async () => {
    const onImport = vi.fn(async () => "doc");
    const late = vi.fn(async () => {}).mockRejectedValueOnce(new Error("upload failed"));
    const { post, upload } = await bootProtocol(onImport, late);
    await post("saveItems", { sessionID: "retry-fail", items: [{ id: "paper", title: "Paper" }] });
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect((await upload("retry-fail", "pdf", "paper")).status).toBe(500);
    const failed = await (await post("sessionProgress", { sessionID: "retry-fail" })).json();
    expect(failed.items[0].attachments[0]).toMatchObject({ progress: false, error: "upload failed" });
    expect((await upload("retry-fail", "pdf", "paper")).status).toBe(201);
    expect(late).toHaveBeenCalledTimes(2);
    expect(onImport).toHaveBeenCalledTimes(1);
    expect((await (await post("sessionProgress", { sessionID: "retry-fail" })).json()).items[0].attachments[0].progress).toBe(100);
  });

  it("does not wait for linked-only attachments", async () => {
    const onImport = vi.fn(async () => "doc");
    const { post } = await bootProtocol(onImport);
    await post("saveItems", { sessionID: "linked", items: [{ id: "a", title: "A", attachments: [{ id: "url", snapshot: false, url: "https://example.org/" }] }] });
    await vi.waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const progress = await (await post("sessionProgress", { sessionID: "linked" })).json();
    expect(progress).toMatchObject({ done: true, items: [{ attachments: [] }] });
  });

});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });
}
