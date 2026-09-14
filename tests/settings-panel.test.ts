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
