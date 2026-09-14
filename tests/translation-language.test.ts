import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KernelClient } from "../src/core/kernel";
import { TranslatorService } from "../src/services/translator";
import { DEFAULT_SETTINGS, pdf2zhLanguageCode, type PluginSettings } from "../src/types/settings";
import { paper } from "./fixtures";

/**
 * pdf2zh 的语言设置只在命令行下走 -li/-lo：配置里的 PDF2ZH_LANG_FROM/TO 仅被
 * 它自己的 GUI（gui.py）读取，CLI 路径完全不读（实测 config 写 klingon→vulcan、
 * 不传 -li/-lo 时 translator 收到 argparse 默认的 en→zh）。
 * 所以插件必须始终显式传 -li/-lo，否则用户改语言不会有任何效果——这里锁定该契约。
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

it("passes the plugin's configured languages through -li/-lo", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "ja", translateTo: "ko", pdf2zhConfig: { translators: [{ name: "google", envs: {} }] },
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("ja");
    expect(flag(args[0]!, "-lo")).toBe("ko");
  } finally { cleanup(); }
});

it("normalizes full language names from the plugin settings", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    // pdf2zh 的 GUI 把语言存为全名；插件设置里也可能是它导入的全名。
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "English", translateTo: "Simplified Chinese", pdf2zhConfig: {},
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("en");
    expect(flag(args[0]!, "-lo")).toBe("zh");
  } finally { cleanup(); }
});

it("ignores language keys left over in the managed config", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    // 语言不是配置项：配置里残留的 PDF2ZH_LANG_* 不得覆盖插件设置，
    // 否则用户改了设置却没有效果。
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "fr", translateTo: "de",
      pdf2zhConfig: { PDF2ZH_LANG_FROM: "English", PDF2ZH_LANG_TO: "Simplified Chinese", translators: [{ name: "google", envs: {} }] },
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("fr");
    expect(flag(args[0]!, "-lo")).toBe("de");
  } finally { cleanup(); }
});

it("does not write language keys into the managed config", async () => {
  const { root, translator, cleanup } = setup();
  try {
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "ja", translateTo: "ko",
      // 已有配置文件里残留的语言键应被剔除，不能原样写回。
      pdf2zhConfigPath: join(root, "pdf2zh", "config.json"),
    })).catch(() => {});
    const written = JSON.parse(readFileSync(join(root, "pdf2zh", "config.json"), "utf8")) as Record<string, unknown>;
    expect(written.PDF2ZH_LANG_FROM).toBeUndefined();
    expect(written.PDF2ZH_LANG_TO).toBeUndefined();
  } finally { cleanup(); }
});

it("always passes -li/-lo so pdf2zh never falls back to its en→zh default", async () => {
  const { root, translator, args, cleanup } = setup();
  try {
    // A language pair that differs from pdf2zh's built-in default: if the flags
    // were dropped, pdf2zh would silently translate en→zh instead of ja→ko.
    await translator.translate("doc", withLanguages(root, {
      translateFrom: "ja", translateTo: "ko", pdf2zhConfig: {},
    })).catch(() => {});
    expect(flag(args[0]!, "-li")).toBe("ja");
    expect(flag(args[0]!, "-lo")).toBe("ko");
    expect(args[0]!).toContain("-li");
    expect(args[0]!).toContain("-lo");
  } finally { cleanup(); }
});
