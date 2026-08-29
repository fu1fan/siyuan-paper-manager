import { Setting, showMessage } from "siyuan";
import { newNodeId } from "../core/node-id";
import type { KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import { LIBRARY_FIELD_LABELS, type LibraryMetadataField } from "../types/library";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";

type TabName = "library" | "receiving" | "storage" | "metadata" | "translation";

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;

  constructor(
    private readonly pluginName: string,
    initial: PluginSettings,
    private readonly kernel: KernelClient,
    private readonly libraries: LibraryService,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
  ) {
    this.draft = structuredClone(initial);
    this.setting = new Setting({
      width: "820px",
      height: "680px",
      confirmCallback: () => { void this.save(); },
    });
    this.setting.addItem({ title: "", direction: "column", createActionElement: () => this.build() });
  }

  open(): void { this.setting.open(this.pluginName); }

  private build(): HTMLElement {
    const root = document.createElement("div");
    root.className = "paper-manager-form";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
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
      tab.className = "b3-button b3-button--outline";
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
      ${textField("附件目录", "assetsDir", this.draft.assetsDir)}
      ${switchField("启用编辑元数据 UI", "enableEditUI", this.draft.enableEditUI)}
      <div class="paper-manager-preview">元数据模板与笔记模板随插件打包，不写入 data/templates。</div>`;
    panels.get("metadata")!.innerHTML = `
      ${switchField("中文检索（实验性）", "enableCnki", this.draft.enableCnki)}
      <div class="paper-manager-preview">本地 XMP/文档属性 → DOI/Crossref → Citoid → 中文候选。</div>`;
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
      <div class="paper-manager-field paper-manager-field--column"><span>投影到数据库的元数据</span><div class="paper-manager-checkboxes">${
        Object.entries(LIBRARY_FIELD_LABELS).map(([field, label]) => `<label><input type="checkbox" data-library-field="${field}" ${selected.data.selectedFields.includes(field as LibraryMetadataField) ? "checked" : ""}> ${escapeHtml(label)}</label>`).join("")
      }</div></div>
      <label class="paper-manager-field paper-manager-field--column"><span>项目（每行：项目名 | 可选项目文档 ID）</span><textarea class="b3-text-field" rows="5" data-projects>${escapeHtml(selected.data.projects.map((project) => `${project.name}${project.docId ? ` | ${project.docId}` : ""}`).join("\n"))}</textarea></label>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>重新同步</button>
        <button type="button" class="b3-button b3-button--text" data-repair>修复数据库</button>
        <button type="button" class="b3-button b3-button--text" data-project-save>保存项目</button>
        <button type="button" class="b3-button b3-button--primary" data-field-save>应用字段并重建</button>
      </div>`;
    editor.querySelector<HTMLButtonElement>("[data-sync]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.syncLibrary(selected.docId);
      return `同步完成：${result.papers} 篇，恢复 ${result.restoredRows} 行，移除 ${result.removedRows} 行，失败 ${result.failed.length} 篇`;
    });
    editor.querySelector<HTMLButtonElement>("[data-repair]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.repairLibrary(selected.docId);
      return `修复完成：同步 ${result.papers} 篇论文`;
    });
    editor.querySelector<HTMLButtonElement>("[data-project-save]")!.onclick = () => void actionMessage(async () => {
      await this.libraries.updateProjects(selected.docId, parseProjects(editor.querySelector<HTMLTextAreaElement>("[data-projects]")!.value, selected));
      return "项目设置已保存并同步";
    });
    editor.querySelector<HTMLButtonElement>("[data-field-save]")!.onclick = () => void actionMessage(async () => {
      const fields = Array.from(editor.querySelectorAll<HTMLInputElement>("[data-library-field]:checked"), (input) => input.dataset.libraryField as LibraryMetadataField);
      const result = await this.libraries.applySelectedFields(selected.docId, fields);
      return `字段已应用并重建 ${result.papers} 篇论文`;
    });
  }

  private async save(): Promise<void> {
    try {
      const settings = normalizeSettings(this.draft);
      settings.onboardingCompleted = Boolean(settings.defaultLibraryDocId);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
      showMessage("论文管理设置已保存", 3000, "info");
    } catch (error) { showMessage(`设置保存失败：${message(error)}`, 5000, "error"); }
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
function librarySelector(libraries: PaperLibraryInfo[], selected: string): string {
  return `<label class="paper-manager-field"><span>默认文献库</span><select class="b3-select" data-default-library>${libraries.map((library) =>
    `<option value="${escapeHtml(library.docId)}" ${library.docId === selected ? "selected" : ""}>${escapeHtml(library.title)}</option>`).join("")}</select></label>`;
}
function parseProjects(value: string, library: PaperLibraryInfo) {
  const existing = new Map(library.data.projects.map((project) => [project.name, project.id]));
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [name = "", docId = ""] = line.split("|").map((part) => part.trim());
    return { id: existing.get(name) ?? library.data.projects[index]?.id ?? newNodeId(), name, docId: docId || undefined };
  });
}
async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`文献库操作失败：${message(error)}`, 7000, "error"); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
