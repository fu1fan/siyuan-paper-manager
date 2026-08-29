import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { encodePaperData } from "../src/core/codec";
import { KernelClient } from "../src/core/kernel";
import { MetadataExtractor, parseCnkiHtml } from "../src/services/metadata-extractor";
import { parseProgress, TranslatorService } from "../src/services/translator";
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
});

describe.skipIf(process.platform === "win32")("translator integration", () => {
  it("runs a fake pdf2zh executable, validates PDFs, uploads, and persists", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-manager-translator-test-"));
    const dataDir = join(root, "data", "assets");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "input.pdf"), "%PDF-1.4\ninput");
    const executable = join(root, "fake-pdf2zh.sh");
    writeFileSync(executable, `#!/bin/sh\nout=""\nlast=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; out="$1"; else last="$1"; fi\n  shift\ndone\nbase=$(basename "$last" .pdf)\nprintf '%%PDF-1.4\\nmono' > "$out/$base-mono.pdf"\nprintf '%%PDF-1.4\\ndual' > "$out/$base-dual.pdf"\necho '100%'\n`);
    chmodSync(executable, 0o755);
    const current = paper({
      attachments: [{ title: "input.pdf", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "x" }],
    });
    const uploads: string[] = [];
    const post = async (endpoint: string) => {
      if (endpoint === "/api/attr/getBlockAttrs") return { "custom-paper-data": encodePaperData(current) };
      if (endpoint === "/api/system/getWorkspaceInfo") return { workspaceDir: root };
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
    const translator = new TranslatorService(new KernelClient(post as any, fakeFetch as typeof fetch), {
      requireFn: createRequire(import.meta.url),
      persist: async (_docId, updated) => {
        persisted = true;
        expect(updated.translation.mono).toBe("assets/张2026示例论文-mono.pdf");
        expect(updated.translation.dual).toBe("assets/张2026示例论文-dual.pdf");
      },
    });
    try {
      const result = await translator.translate("doc", {
        zoteroPort: 23119, autoListen: true,
        defaultLibraryDocId: "library-doc", onboardingCompleted: true, assetsDir: "/assets/",
        enableEditUI: true, enableCnki: false, pdf2zhPath: executable, translateFrom: "en", translateTo: "zh",
        translateService: "google", translationDual: true, pdf2zhArgs: [], translationAssetsDir: "/assets/",
      });
      expect(result.mono).toContain("-mono.pdf");
      expect(uploads).toHaveLength(2);
      expect(persisted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
