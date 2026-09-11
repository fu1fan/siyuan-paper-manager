import { Setting, showMessage } from "siyuan";
import type { KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, serializeArgs, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";

type TabName = "library" | "receiving" | "storage" | "metadata" | "translation";

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;

  constructor(
    private readonly displayName: string,
    private readonly getSettings: () => PluginSettings,
    private readonly kernel: KernelClient,
    private readonly libraries: LibraryService,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
  ) {
    this.draft = structuredClone(getSettings());
    this.setting = new Setting({
      width: "820px",
      height: "680px",
      confirmCallback: () => { void this.save(); },
    });
    this.setting.addItem({ title: "", direction: "column", createActionElement: () => this.build() });
  }

  open(): void { this.setting.open(this.displayName); }

  private build(): HTMLElement {
    this.draft = structuredClone(this.getSettings());
    const root = document.createElement("div");
    root.className = "paper-manager-form paper-manager-settings";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "论文管理设置");
    const panels = new Map<TabName, HTMLElement>();
    const names: Array<[TabName, string]> = [
      ["library", "文献库"], ["receiving", "导入与接收"], ["storage", "论文存储"],
      ["metadata", "PDF 元数据"], ["translation", "翻译"],
    ];
    const activate = (name: TabName) => {
      for (const panel of panels.values()) {
        const active = panel.dataset.panel === name;
        panel.dataset.active = String(active);
        panel.hidden = !active;
        panel.setAttribute("aria-hidden", String(!active));
      }
      for (const tab of tabs.querySelectorAll<HTMLButtonElement>("button")) {
        const active = tab.dataset.tab === name;
        tab.dataset.active = String(active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
    };
    for (const [name, label] of names) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "paper-manager-tab";
      tab.textContent = label;
      tab.dataset.tab = name;
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); activate(name); });
      tabs.append(tab);
      const panel = document.createElement("section");
      panel.className = "paper-manager-panel";
      panel.dataset.panel = name;
      panel.setAttribute("role", "tabpanel");
      panels.set(name, panel);
      root.append(panel);
    }
    root.prepend(tabs);
    panels.get("library")!.innerHTML = `<div data-library-content>正在读取文献库…</div>`;
    panels.get("receiving")!.innerHTML = `
      ${numberField("Zotero 端口", "zoteroPort", this.draft.zoteroPort)}
      ${switchField("启动时自动监听", "autoListen", this.draft.autoListen)}
      <div class="paper-manager-preview">Connector 与本地 PDF 始终导入默认文献库。</div>`;
    panels.get("storage")!.innerHTML = `
      ${textField("论文文档默认标签（留空不添加）", "defaultDocumentTag", this.draft.defaultDocumentTag)}
      <p class="paper-manager-hint">填写一个标签名，不含 # 或逗号。保存后同步全部文献库中的论文文档，新建论文也会自动添加。修改会替换原默认标签，清空会删除原默认标签；其他文档标签保留，不修改数据库关键词。</p>
      ${textField("附件目录", "assetsDir", this.draft.assetsDir)}
      <div class="paper-manager-preview">元数据模板与笔记模板随插件打包，不写入 data/templates。</div>`;
    panels.get("metadata")!.innerHTML = `
      ${switchField("自动提取元数据", "autoExtractMetadata", this.draft.autoExtractMetadata)}
      <p class="paper-manager-hint">选择 PDF 后自动提取并联网补充。关闭后仍可在导入页点击「提取元数据」。</p>
      ${switchField("使用 Zotero 在线识别", "enableZoteroRecognizer", this.draft.enableZoteroRecognizer)}
      <p class="paper-manager-hint">开启后，提取时会将 PDF 前五页文本、排版、内嵌元数据及文件名发送至 Zotero 官方识别服务。</p>
      ${switchField("中文检索（实验性）", "enableCnki", this.draft.enableCnki)}
      ${numberField("知网单次请求超时（秒，1–120）", "cnkiTimeoutSeconds", this.draft.cnkiTimeoutSeconds, 1, 120)}
      <div class="paper-manager-preview">默认 10 秒。分别用于搜索、详情和引用补充的单次网络请求，包含连接及完整响应接收时间；不包含手动验证等待。保存后下次检索生效。</div>
      <label class="paper-manager-field"><span>知网站点</span><select class="b3-select" data-key="cnkiRegion"><option value="mainland" ${this.draft.cnkiRegion !== "oversea" ? "selected" : ""}>中国大陆</option><option value="oversea" ${this.draft.cnkiRegion === "oversea" ? "selected" : ""}>海外</option></select></label>
      <div class="paper-manager-preview">知网检索需要思源桌面端。首次检索或会话过期时会打开知网窗口；请完成验证后返回继续，同一会话会自动复用。</div>
      <div class="paper-manager-preview">提取结果会展示多个候选，导入前可核对并编辑标题、作者与摘要。</div>`;
    panels.get("translation")!.innerHTML = `
      ${textField("pdf2zh 路径", "pdf2zhPath", this.draft.pdf2zhPath)}
      ${textField("源语言", "translateFrom", this.draft.translateFrom)}
      ${textField("目标语言", "translateTo", this.draft.translateTo)}
      ${translationServiceField(this.draft.translateService)}
      ${numberField("请求并发数（每篇 PDF，1–128）", "translationThreads", this.draft.translationThreads, 1, 128)}
      ${numberField("同时翻译篇数（1–8）", "translationConcurrency", this.draft.translationConcurrency, 1, 8)}
      ${switchField("保留双语版", "translationDual", this.draft.translationDual)}
      ${switchField("重新翻译后删除旧版本", "autoDeleteOldTranslations", this.draft.autoDeleteOldTranslations)}
      ${textareaField("额外 CLI 参数", "pdf2zhArgs", serializeArgs(this.draft.pdf2zhArgs))}
      ${textField("翻译资源目录", "translationAssetsDir", this.draft.translationAssetsDir)}
      <div class="paper-manager-preview">请求并发数对应 pdf2zh 的 --thread（-t），默认 4；同时翻译多篇时，总请求并发最多约为两项设置的乘积。服务所需密钥请在 pdf2zh 配置文件或环境变量中设置。并行篇数下次提交时生效，取消会停止全部任务。自动删除仅在新翻译及元数据保存成功后执行；删除失败不会影响新版本。</div>`;
    root.addEventListener("input", (event) => this.capture(event));
    root.addEventListener("change", (event) => this.capture(event));
    activate("library");
    void this.renderLibraries(root);
    return root;
  }

  private capture(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const key = input.dataset.key as keyof PluginSettings | undefined;
    if (!key) return;
    let value: unknown = input instanceof HTMLInputElement && input.type === "checkbox"
      ? input.checked
      : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (key === "pdf2zhArgs") value = splitArgString(String(value));
    (this.draft as unknown as Record<string, unknown>)[key] = value;
  }

  private async renderLibraries(root: HTMLElement): Promise<void> {
    const container = root.querySelector<HTMLElement>("[data-library-content]")!;
    try {
      const libraries = await this.libraries.discoverLibraries();
      if (!this.draft.defaultLibraryDocId && libraries[0]) this.draft.defaultLibraryDocId = libraries[0].docId;
      container.innerHTML = `${libraries.length ? librarySelector(libraries, this.draft.defaultLibraryDocId) : "<div class=\"paper-manager-preview\">尚未创建文献库。</div>"}
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-create-library>新建文献库</button></div>
        <div data-library-editor></div>`;
      container.querySelector<HTMLSelectElement>("[data-default-library]")?.addEventListener("change", (event) => {
        this.draft.defaultLibraryDocId = (event.target as HTMLSelectElement).value;
        void this.renderLibraryEditor(container, libraries);
      });
      container.querySelector<HTMLButtonElement>("[data-create-library]")!.addEventListener("click", () => {
        void openOnboardingDialog(this.kernel, this.libraries, async (library) => {
          this.draft.defaultLibraryDocId = library.docId;
          this.draft.onboardingCompleted = true;
          await this.onSave(normalizeSettings(this.draft));
          await this.renderLibraries(root);
        }, "新建论文文献库");
      });
      await this.renderLibraryEditor(container, libraries);
    } catch (error) {
      container.innerHTML = `<div class="paper-manager-preview">读取失败：${escapeHtml(message(error))}</div>`;
    }
  }

  private async renderLibraryEditor(container: HTMLElement, libraries: PaperLibraryInfo[]): Promise<void> {
    const editor = container.querySelector<HTMLElement>("[data-library-editor]");
    if (!editor) return;
    const selected = libraries.find((library) => library.docId === this.draft.defaultLibraryDocId) ?? libraries[0];
    if (!selected) { editor.innerHTML = ""; return; }
    editor.innerHTML = `<hr class="b3-hr"><h3>${escapeHtml(selected.title)}</h3>
      <div class="paper-manager-preview">${escapeHtml(selected.hPath)} · 数据库 ${escapeHtml(selected.data.avId)}</div>
      <div class="paper-manager-preview">请直接在数据库「所属项目」中填写或选择项目，可多选；列的显示与排序也在数据库视图中操作。</div>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>重新同步</button>
        <button type="button" class="b3-button b3-button--text" data-repair>修复数据库</button>
      </div>`;
    editor.querySelector<HTMLButtonElement>("[data-sync]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.syncLibrary(selected.docId);
      return `同步完成：${result.papers} 篇，恢复 ${result.restoredRows} 行，移除 ${result.removedRows} 行，失败 ${result.failed.length} 篇`;
    });
    editor.querySelector<HTMLButtonElement>("[data-repair]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.repairLibrary(selected.docId);
      return `修复完成：同步 ${result.papers} 篇论文`;
    });
  }

  private async save(): Promise<void> {
    try {
      const settings = normalizeSettings(this.draft);
      settings.onboardingCompleted = Boolean(settings.defaultLibraryDocId);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
    } catch (error) {
      showMessage(`设置保存失败：${message(error)}`, 5000, "error");
      return;
    }
    showMessage("论文管理设置已保存", 5000, "info");
  }
}

function textField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
function numberField(label: string, key: keyof PluginSettings, value: number, min = 1024, max = 65535): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" type="number" min="${min}" max="${max}" step="1" data-key="${key}" value="${value}"></label>`;
}
function switchField(label: string, key: keyof PluginSettings, value: boolean): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><span><input class="b3-switch" type="checkbox" data-key="${key}" ${value ? "checked" : ""}></span></label>`;
}
function textareaField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}</span><textarea class="b3-text-field" rows="4" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
}
function librarySelector(libraries: PaperLibraryInfo[], selected: string): string {
  return `<label class="paper-manager-field"><span>默认文献库</span><select class="b3-select" data-default-library>${libraries.map((library) =>
    `<option value="${escapeHtml(library.docId)}" ${library.docId === selected ? "selected" : ""}>${escapeHtml(library.title)}</option>`).join("")}</select></label>`;
}

async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`文献库操作失败：${message(error)}`, 7000, "error"); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function translationServiceField(value: string): string {
  const services = ["google", "bing", "deepl", "openai", "ollama", "deepseek", "azure", "gemini", "silicon"];
  if (!services.includes(value)) services.push(value);
  return `<label class="paper-manager-field"><span>翻译服务</span><select class="b3-select" data-key="translateService">${services.map((service) => `<option value="${escapeHtml(service)}" ${service === value ? "selected" : ""}>${escapeHtml(service)}</option>`).join("")}</select></label>`;
}
