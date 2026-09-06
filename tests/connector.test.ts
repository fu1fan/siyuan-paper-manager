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

  afterEach(async () => {
    await connector?.stop();
    connector = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("implements ping, version checks, multi-item attachment mapping, and 501", async () => {
    const port = await freePort();
    directory = mkdtempSync(join(tmpdir(), "paper-manager-connector-test-"));
    const received: ImportCandidate[] = [];
    connector = new ConnectorServer({
      port,
      tempDirectory: directory,
      requireFn: createRequire(import.meta.url),
      graceMs: 30,
      onImport: (candidate) => { received.push(candidate); },
    });
    await connector.start();
    const base = `http://127.0.0.1:${port}`;
    const ping = await fetch(`${base}/connector/ping`, { method: "POST" });
    expect(ping.status).toBe(200);
    expect((await ping.json()).prefs.supportsAttachmentUpload).toBe(true);

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
    expect(attachment.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(received).toHaveLength(2);
    expect(received.find((item) => item.canonical.title === "Paper A")?.attachments).toHaveLength(1);
    expect(received.find((item) => item.canonical.title === "Paper B")?.attachments).toHaveLength(0);

    const unsupported = await fetch(`${base}/connector/installStyle`, { method: "POST" });
    expect(unsupported.status).toBe(501);
  }, 10_000);
  it.each(["saveItems", "saveSnapshot"])("keeps attachments when %s and uploads are retried", async (route) => {
    const port = await freePort();
    directory = mkdtempSync(join(tmpdir(), "paper-manager-retry-test-"));
    const received: ImportCandidate[] = [];
    connector = new ConnectorServer({ port, tempDirectory: directory, requireFn: createRequire(import.meta.url),
      graceMs: 30, onImport: (candidate) => { received.push(candidate); } });
    await connector.start();
    const base = `http://127.0.0.1:${port}`;
    const save = () => fetch(`${base}/connector/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: "retry", items: [{ id: "paper", title: "Paper", attachments: [{ id: "a" }, { id: "b" }] }] }),
    });
    const upload = (id: string, body: string) => fetch(`${base}/connector/saveAttachment?sessionID=retry`, {
      method: "POST", headers: { "X-Metadata": JSON.stringify({ id, parentItemID: "paper", title: "paper.pdf" }) }, body,
    });
    await save();
    await upload("a", "original");
    await save();
    await upload("a", "duplicate");
    expect(readdirSync(directory)).toHaveLength(1);
    expect(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")).toBe("original");
    await upload("b", "second");
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.attachments).toHaveLength(2);
    await save();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(received).toHaveLength(1);
  });

  it("does not dispatch a session while its attachment is still streaming", async () => {
    const port = await freePort();
    directory = mkdtempSync(join(tmpdir(), "paper-manager-stream-test-"));
    const received: ImportCandidate[] = [];
    connector = new ConnectorServer({ port, tempDirectory: directory, requireFn: createRequire(import.meta.url),
      graceMs: 20, attachmentWaitMs: 40, onImport: (candidate) => { received.push(candidate); } });
    await connector.start();
    const base = `http://127.0.0.1:${port}`;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(0);
    request.end("last chunk");
    expect(await finished).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.attachments).toHaveLength(1);
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
