import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath } from "../src/services/pdf2zh-deployment";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { SettingsPanel } from "../src/ui/settings";

/**
 * 语言是 pdf2zh 的 CLI 参数（-li/-lo），不是配置项——配置里的 PDF2ZH_LANG_FROM/TO
 * 只有它的 GUI 会读。因此语言控件必须位于「插件翻译设置」并写回插件设置
 * （data-key），而不能留在「pdf2zh 配置文件」面板里（data-config-key）。
 *
 * 测试环境没有 DOM，故只校验面板生成的 HTML；私有方法通过断言类型访问。
 */
function panelHtml(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): string {
  const original = (globalThis as { window?: unknown }).window;
  // canUseNode() 需要 window.require 才是桌面环境，翻译面板此时才渲染。
  (globalThis as { window?: unknown }).window = { require: () => ({}) };
  try {
    const panel = new SettingsPanel("test", () => ({ ...DEFAULT_SETTINGS, ...overrides }),
      {} as never, {} as never, async () => {});
    return (panel as unknown as { translationPanelHtml(): string }).translationPanelHtml();
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  }
}

/** 「pdf2zh 配置文件」可视化面板的 HTML（语言不该出现在这里）。 */
function configPanelHtml(html: string): string {
  const start = html.indexOf('data-config-panel="visual"');
  const end = html.indexOf('data-config-panel="json"');
  return html.slice(start, end);
}

/** 「插件翻译设置」段的 HTML（语言应该在这里）。 */
function settingsSectionHtml(html: string): string {
  return html.slice(html.indexOf("插件翻译设置"));
}

describe("translation settings placement", () => {
  it("keeps pdf2zh languages in the plugin translation settings, not the managed config", () => {
    const html = panelHtml({ translateFrom: "ja", translateTo: "ko" });
    const config = configPanelHtml(html);
    const settings = settingsSectionHtml(html);

    // 不在配置面板里，且不得以 data-config-key 绑到配置对象。
    expect(config).not.toMatch(/PDF2ZH_LANG|translateFrom|translateTo/);
    expect(html).not.toMatch(/data-config-key="translate/);
    // 在插件翻译设置里，并以 data-key 写回设置（否则 capture() 不会保存）。
    expect(settings).toMatch(/<span>源语言<\/span>/);
    expect(settings).toMatch(/<span>目标语言<\/span>/);
    expect(settings).toMatch(/data-key="translateFrom"/);
    expect(settings).toMatch(/data-key="translateTo"/);
    expect(settings).toMatch(/value="ja" selected/);
    expect(settings).toMatch(/value="ko" selected/);
  });

  it("keeps the config-only font path in the managed config panel", () => {
    // NOTO_FONT_PATH 确实会被 pdf2zh 的命令行读取，所以仍属于配置。
    expect(configPanelHtml(panelHtml({ pdf2zhConfig: { NOTO_FONT_PATH: "/f.ttf" } })))
      .toMatch(/data-config-key="NOTO_FONT_PATH"/);
  });

  it("explains that languages are passed as CLI arguments", () => {
    expect(settingsSectionHtml(panelHtml())).toMatch(/-li/);
    expect(settingsSectionHtml(panelHtml())).toMatch(/-lo/);
  });
});

describe("translation credential mappings", () => {
  it("renders every Tencent credential and preserves its separate mapping", () => {
    const html = panelHtml({
      pdf2zhConfig: { translators: [{ name: "tencent", envs: {} }] },
      pdf2zhSecretNames: { TENCENTCLOUD_SECRET_ID: "tencent-id", TENCENTCLOUD_SECRET_KEY: "tencent-key" },
    });
    expect(html).toContain('data-secret-name="TENCENTCLOUD_SECRET_ID" value="tencent-id"');
    expect(html).toContain('data-secret-name="TENCENTCLOUD_SECRET_KEY" value="tencent-key"');
  });

  it("renders one field for a single-key service and none for a keyless service", () => {
    const deepseek = panelHtml({ pdf2zhConfig: { translators: [{ name: "deepseek", envs: {} }] } });
    expect(deepseek.match(/data-secret-name=/g)).toHaveLength(1);
    expect(deepseek).toContain('data-secret-name="DEEPSEEK_API_KEY"');
    const google = panelHtml({ pdf2zhConfig: { translators: [{ name: "google", envs: {} }] } });
    expect(google).not.toContain('data-secret-name=');
    expect(google).toContain('data-test-secrets disabled');
  });

  it("tests all Tencent mappings and reports an absent or unresolved key", () => {
    const getSecret = vi.fn((name: string) => ({ "tencent-id": "id-value", "tencent-key": "key-value" })[name] ?? "");
    const panel = new SettingsPanel("test", () => ({
      ...DEFAULT_SETTINGS,
      pdf2zhConfig: { translators: [{ name: "tencent", envs: {} }] },
    }), {} as never, {} as never, async () => {}, getSecret);
    const inputs = [
      { dataset: { secretName: "TENCENTCLOUD_SECRET_ID" }, value: "tencent-id" },
      { dataset: { secretName: "TENCENTCLOUD_SECRET_KEY" }, value: "tencent-key" },
    ];
    const root = { querySelectorAll: () => inputs } as unknown as HTMLElement;
    const test = (panel as unknown as { testSecrets(root: HTMLElement): { message: string; error: boolean } }).testSecrets.bind(panel);
    expect(test(root)).toEqual({ message: "已找到 2 个密钥", error: false });
    expect(getSecret).toHaveBeenCalledWith("tencent-id");
    expect(getSecret).toHaveBeenCalledWith("tencent-key");
    inputs[1]!.value = "";
    expect(test(root)).toEqual({ message: "请先填写映射：TENCENTCLOUD_SECRET_KEY", error: true });
    inputs[1]!.value = "unknown";
    expect(test(root)).toEqual({ message: "缺少密钥：unknown", error: true });
  });
});

it("removes a cleared visual font path from JSON, disk, and the reopened control", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "paper-font-path-"));
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { require: createRequire(import.meta.url) };
  try {
    const panel = new SettingsPanel("test", () => ({
      ...DEFAULT_SETTINGS,
      pdf2zhConfig: { NOTO_FONT_PATH: "/old/font.ttf", translators: [{ name: "google", envs: {} }] },
    }), { getWorkspaceInfo: async () => ({ workspaceDir }) } as never, {} as never, async () => {});
    const font = { dataset: { configKey: "NOTO_FONT_PATH" }, value: "" };
    const translator = { dataset: { configKey: "translator" }, value: "google" };
    const model = { dataset: { configKey: "model" }, value: "", disabled: false };
    const area = { value: "" };
    const visualTab = { dataset: { active: "true" } };
    const root = {
      querySelectorAll: (selector: string) => selector === "[data-config-key]" ? [font, translator, model] : [],
      querySelector: (selector: string) => ({
        "[data-config-json]": area,
        "[data-config-key=model]": model,
        "[data-config-tab='visual']": visualTab,
      })[selector as "[data-config-json]"] ?? null,
    } as unknown as HTMLElement;
    const methods = panel as unknown as {
      renderConfigVisual(root: HTMLElement): void;
      syncVisualToJson(root: HTMLElement): void;
      syncJsonToVisual(root: HTMLElement): void;
      saveConfig(root: HTMLElement, revision: number): Promise<void>;
    };

    methods.renderConfigVisual(root);
    expect(font.value).toBe("/old/font.ttf");
    font.value = "";
    methods.syncVisualToJson(root);
    expect(JSON.parse(area.value)).not.toHaveProperty("NOTO_FONT_PATH");
    await methods.saveConfig(root, 0);
    const saved = JSON.parse(readFileSync(configPath(workspaceDir), "utf8"));
    expect(saved).not.toHaveProperty("NOTO_FONT_PATH");
    expect(font.value).toBe("");
    const reopened = new SettingsPanel("test", () => ({ ...DEFAULT_SETTINGS, pdf2zhConfig: saved }),
      {} as never, {} as never, async () => {}) as unknown as { renderConfigVisual(root: HTMLElement): void };
    area.value = "";
    font.value = "/stale/font.ttf";
    reopened.renderConfigVisual(root);
    expect(font.value).toBe("");

    visualTab.dataset.active = "false";
    area.value = JSON.stringify({ ...saved, NOTO_FONT_PATH: "/json/font.ttf" });
    methods.syncJsonToVisual(root);
    expect(font.value).toBe("/json/font.ttf");
    area.value = JSON.stringify(saved);
    methods.syncJsonToVisual(root);
    expect(font.value).toBe("");
    await methods.saveConfig(root, 0);
    expect(JSON.parse(readFileSync(configPath(workspaceDir), "utf8"))).not.toHaveProperty("NOTO_FONT_PATH");
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
