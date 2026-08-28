import { Setting, showMessage } from "siyuan";
import type { KernelClient } from "../core/kernel";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";

type TabName = "receiving" | "storage" | "metadata" | "translation";

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;

  constructor(
    private readonly pluginName: string,
    initial: PluginSettings,
    private readonly kernel: KernelClient,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
  ) {
    this.draft = structuredClone(initial);
    this.setting = new Setting({
      width: "760px",
      height: "620px",
      confirmCallback: () => { void this.save(); },
    });
    this.setting.addItem({
      title: "",
      direction: "column",
      createActionElement: () => this.build(),
    });
  }

  open(): void {
    this.setting.open(this.pluginName);
  }

  private build(): HTMLElement {
    const root = document.createElement("div");
    root.className = "paper-manager-form";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
    const panels = new Map<TabName, HTMLElement>();
    const names: Array<[TabName, string]> = [
      ["receiving", "导入与接收"], ["storage", "论文存储"], ["metadata", "PDF 元数据"], ["translation", "翻译"],
    ];
    for (const [name, label] of names) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "b3-button b3-button--outline";
      tab.textContent = label;
      tab.dataset.tab = name;
      tab.addEventListener("click", () => activate(name));
      tabs.append(tab);
      const panel = document.createElement("section");
      panel.dataset.panel = name;
      panels.set(name, panel);
      root.append(panel);
    }
    root.prepend(tabs);
    panels.get("receiving")!.innerHTML = `
      ${numberField("Zotero 端口", "zoteroPort", this.draft.zoteroPort)}
      ${switchField("启动时自动监听", "autoListen", this.draft.autoListen)}
      <label class="paper-manager-field"><span>目标笔记本</span><select class="b3-select" data-key="notebookId"><option value="">加载中…</option></select></label>
      ${textField("存放路径", "destPath", this.draft.destPath)}`;
    panels.get("storage")!.innerHTML = `
      ${textField("附件目录", "assetsDir", this.draft.assetsDir)}
      ${switchField("启用编辑元数据 UI", "enableEditUI", this.draft.enableEditUI)}
      <div class="paper-manager-preview">元数据模板与笔记模板随插件打包，不写入 data/templates。</div>`;
    panels.get("metadata")!.innerHTML = `
      ${switchField("中文检索（实验性）", "enableCnki", this.draft.enableCnki)}
      <div class="paper-manager-preview">顺序固定为：本地 XMP/文档属性 → DOI/Crossref → Citoid → 中文候选。扫描 PDF 以文件名兜底。</div>`;
    panels.get("translation")!.innerHTML = `
      ${textField("pdf2zh 路径", "pdf2zhPath", this.draft.pdf2zhPath)}
      ${textField("源语言", "translateFrom", this.draft.translateFrom)}
      ${textField("目标语言", "translateTo", this.draft.translateTo)}
      ${textField("翻译服务", "translateService", this.draft.translateService)}
      ${switchField("保留双语版", "translationDual", this.draft.translationDual)}
      ${textareaField("额外 CLI 参数", "pdf2zhArgs", this.draft.pdf2zhArgs.join(" "))}
      ${textField("翻译资源目录", "translationAssetsDir", this.draft.translationAssetsDir)}`;

    root.addEventListener("input", (event) => this.capture(event));
    root.addEventListener("change", (event) => this.capture(event));
    const activate = (name: TabName) => {
      for (const panel of panels.values()) panel.hidden = panel.dataset.panel !== name;
      for (const tab of tabs.querySelectorAll<HTMLButtonElement>("button")) tab.dataset.active = String(tab.dataset.tab === name);
    };
    activate("receiving");
    void this.populateNotebooks(root.querySelector<HTMLSelectElement>("[data-key=notebookId]")!);
    return root;
  }

  private capture(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const key = input.dataset.key as keyof PluginSettings | undefined;
    if (!key) return;
    let value: unknown = input instanceof HTMLInputElement && input.type === "checkbox"
      ? input.checked
      : input instanceof HTMLInputElement && input.type === "number"
        ? Number(input.value)
        : input.value;
    if (key === "pdf2zhArgs") value = splitArgString(String(value));
    (this.draft as unknown as Record<string, unknown>)[key] = value;
  }

  private async populateNotebooks(select: HTMLSelectElement): Promise<void> {
    try {
      const notebooks = await this.kernel.listNotebooks();
      select.innerHTML = `<option value="">请选择笔记本</option>${notebooks.map((notebook) =>
        `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.name)}</option>`).join("")}`;
      select.value = this.draft.notebookId;
    } catch (error) {
      select.innerHTML = `<option value="">读取失败</option>`;
      console.error("[paper-manager] 读取笔记本失败", error);
    }
  }

  private async save(): Promise<void> {
    try {
      const settings = normalizeSettings(this.draft);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
      showMessage("论文管理设置已保存", 3000, "info");
    } catch (error) {
      showMessage(`设置保存失败：${error instanceof Error ? error.message : String(error)}`, 5000, "error");
    }
  }
}

function textField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}

function numberField(label: string, key: keyof PluginSettings, value: number): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" type="number" min="1024" max="65535" data-key="${key}" value="${value}"></label>`;
}

function switchField(label: string, key: keyof PluginSettings, value: boolean): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><span><input type="checkbox" data-key="${key}" ${value ? "checked" : ""}></span></label>`;
}

function textareaField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}</span><textarea class="b3-text-field" rows="4" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
}
