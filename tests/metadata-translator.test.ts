import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { KernelClient } from "../src/core/kernel";
import { MetadataExtractor, parseCnkiHtml } from "../src/services/metadata-extractor";
import { parseProgress, translationWorkspacePath, TranslatorService } from "../src/services/translator";
import { paper } from "./fixtures";

describe("metadata extraction helpers", () => {
  it("parses CNKI-like result HTML into manual candidates", () => {
    const html = `<table><tr><td><a class="fz14" href="https://kns.cnki.net/kcms/detail/detail.aspx?id=1">中文论文标题</a></td><td class="author">张三</td><td>2025</td></tr></table>`;
    const candidates = parseCnkiHtml(html);
    expect(candidates[0]?.canonical.title).toBe("中文论文标题");
  });

  it("falls back to filename for an unreadable PDF without network access", async () => {
    const extractor = new MetadataExtractor({ fetchImpl: async () => { throw new Error("offline"); } });
    const result = await extractor.extract(new Uint8Array([1, 2, 3]), "离线论文.pdf");
    expect(result.selected.canonical.title).toBe("离线论文");
    expect(result.warnings.join(" ")).toMatch(/解析失败/);
  });

  it("parses only real percentage output", () => {
    expect(parseProgress("layout 42.5%" )).toBe(42);
    expect(parseProgress("processing page 4/20")).toBeUndefined();
  });

  it("only maps plugin translation PDFs to workspace deletion paths", () => {
    expect(translationWorkspacePath("assets/translations/paper-mono.pdf")).toBe("/data/assets/translations/paper-mono.pdf");
    expect(translationWorkspacePath("/assets/translations/paper-mono.pdf")).toBe("/data/assets/translations/paper-mono.pdf");
    expect(() => translationWorkspacePath("../conf/conf.json")).toThrow(/路径不合法/);
    expect(() => translationWorkspacePath("assets/original.pdf")).toThrow(/仅删除插件生成/);
  });
});

describe("translator integration", () => {
  it("runs a fake pdf2zh executable, validates PDFs, uploads, and persists", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-manager-translator-test-"));
    const dataDir = join(root, "data", "assets");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "中文 input.pdf"), "%PDF-1.4\ninput");
    const executable = process.execPath;
    const fixture = fileURLToPath(new URL("./fixtures/fake-pdf2zh.mjs", import.meta.url));
    const current = paper({
      attachments: [{ title: "中文 input.pdf", mimeType: "application/pdf", assetAddress: "assets/中文 input.pdf", sha256: "x" }],
      translation: { mono: "assets/old-mono.pdf", dual: "assets/old-dual.pdf" },
    });
    const uploads: string[] = [];
    const removals: string[] = [];
    const events: string[] = [];
    const post = async (endpoint: string, payload?: Record<string, unknown>) => {
      if (endpoint === "/api/system/getWorkspaceInfo") return { workspaceDir: root };
      if (endpoint === "/api/file/removeFile") {
        events.push("remove");
        removals.push(String(payload?.path));
        return null;
      }
      throw new Error(endpoint);
    };
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file[]") as File;
      uploads.push(file.name);
      return new Response(JSON.stringify({ code: 0, data: { succMap: { [file.name]: `assets/${file.name}` } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    let persisted = false;
    let reads = 0;
    const latest = paper({ ...current, canonical: { ...current.canonical, title: "翻译期间更新的标题" },
      attachments: [...current.attachments, { title: "extra", mimeType: "text/html", assetAddress: "assets/extra.html", sha256: "extra" }],
    });
    const translator = new TranslatorService(new KernelClient(post as any, fakeFetch as typeof fetch), {
      requireFn: createRequire(import.meta.url),
      spawnProcess: (command, args, options) => spawn(command, [fixture, ...args], options),
      readPaper: async () => ++reads === 1 ? current : latest,
      persist: async (_docId, updated) => {
        events.push("persist");
        persisted = true;
        expect(updated.canonical.title).toBe("翻译期间更新的标题");
        expect(updated.attachments).toHaveLength(2);
        expect(updated.translation.mono).toBe("assets/张2026示例论文-mono.pdf");
        expect(updated.translation.dual).toBe("assets/张2026示例论文-dual.pdf");
      },
    });
    try {
      const result = await translator.translate("doc", {
        zoteroPort: 23119, autoListen: true,
        defaultLibraryDocId: "library-doc", onboardingCompleted: true, assetsDir: "/assets/",
        enableCnki: false, pdf2zhPath: executable, translateFrom: "en", translateTo: "zh",
        translateService: "google", translationDual: true, autoDeleteOldTranslations: true,
        pdf2zhArgs: ["--config", String.raw`C:\Users\测试 User\config.json`, "", 'embedded"quote'], translationAssetsDir: "/assets/",
      });
      const received = JSON.parse(readFileSync(join(dataDir, "中文 input.pdf.args.json"), "utf8"));
      expect(received.slice(-5)).toEqual(["--config", String.raw`C:\Users\测试 User\config.json`, "", 'embedded"quote', join(dataDir, "中文 input.pdf")]);
      expect(result.mono).toContain("-mono.pdf");
      expect(uploads).toHaveLength(2);
      expect(persisted).toBe(true);
      expect(removals).toEqual(["/data/assets/old-mono.pdf", "/data/assets/old-dual.pdf"]);
      expect(events).toEqual(["persist", "remove", "remove"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
