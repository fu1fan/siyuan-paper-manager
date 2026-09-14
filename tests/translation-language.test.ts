import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KernelClient } from "../src/core/kernel";
import { TranslatorService } from "../src/services/translator";
import { DEFAULT_SETTINGS, pdf2zhLanguageCode, type PluginSettings } from "../src/types/settings";
import { paper } from "./fixtures";

/**
 * pdf2zh 的配置文件里 PDF2ZH_LANG_FROM/TO 只有它自己的 GUI 会读，CLI 完全忽略，
 * 只有 -li/-lo 生效。设置面板把语言编辑迁到配置对象后，必须仍把它们翻译成 CLI 参数，
 * 否则用户改语言不会有任何效果。
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "paper-lang-"));
  mkdirSync(join(root, "data/assets"), { recursive: true });
  writeFileSync(join(root, "data/assets/input.pdf"), "%PDF-1.4\n");
  const input = paper({ attachments: [{ title: "原稿", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "x" }] });
  const args: string[][] = [];
  const translator = new TranslatorService({
    getWorkspaceInfo: async () => ({ workspaceDir: root }),
    uploadAsset: async () => "assets/result.pdf",
  } as unknown as KernelClient, {
    requireFn: createRequire(import.meta.url),
    readPaper: async () => input,
    persist: vi.fn(),
    spawnProcess: (_exe, argv, _options: SpawnOptions) => {
      args.push(argv);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      const output = argv[argv.indexOf("-o") + 1]!;
      writeFileSync(join(output, "input-mono.pdf"), "%PDF-1.4\n");
      setImmediate(() => child.emit("close", 0, null));
      return child as unknown as ChildProcess;
    },
  });
  return { root, translator, args, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withLanguages(root: string, overrides: Partial<PluginSettings>): PluginSettings {
  return { ...DEFAULT_SETTINGS, pdf2zhPath: process.execPath, translationDual: false, pdf2zhConfigPath: join(root, "pdf2zh", "config.json"), ...overrides };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

it("normalizes pdf2zh's full language names to CLI codes", () => {
  expect(pdf2zhLanguageCode("English")).toBe("en");
  expect(pdf2zhLanguageCode("simplified chinese")).toBe("zh");
  expect(pdf2zhLanguageCode("zh-TW")).toBe("zh-TW");
  expect(pdf2zhLanguageCode("")).toBe("");
});

it("passes the managed config languages through -li/-lo", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    await translator.translate("doc", withLanguages(root, {
      pdf2zhConfig: { PDF2ZH_LANG_FROM: "English", PDF2ZH_LANG_TO: "Simplified Chinese", translators: [{ name: "google", envs: {} }] },
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("en");
    expect(flag(args[0]!, "-lo")).toBe("zh");
  } finally { cleanup(); }
});

it("falls back to the plugin translation settings when the config omits languages", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "en", translateTo: "zh", pdf2zhConfig: { translators: [{ name: "google", envs: {} }] },
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("en");
    expect(flag(args[0]!, "-lo")).toBe("zh");
  } finally { cleanup(); }
});
