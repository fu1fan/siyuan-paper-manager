import { Setting, showMessage } from "siyuan";
import { newNodeId } from "../core/node-id";
import type { DocumentSearchResult, KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import type { LibraryProject } from "../types/library";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, serializeArgs, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";

type TabName = "library" | "receiving" | "storage" | "metadata" | "translation";

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;
  private activeLibrary: PaperLibraryInfo | undefined;
  private libraryEditor: HTMLElement | undefined;

  constructor(
    private readonly pluginName: string,
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

  open(): void { this.setting.open(this.pluginName); }

  private build(): HTMLElement {
    this.draft = structuredClone(this.getSettings());
    this.activeLibrary = undefined;
    this.libraryEditor = undefined;
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
      ${switchField("重新翻译后删除旧版本", "autoDeleteOldTranslations", this.draft.autoDeleteOldTranslations)}
      ${textareaField("额外 CLI 参数", "pdf2zhArgs", serializeArgs(this.draft.pdf2zhArgs))}
      ${textField("翻译资源目录", "translationAssetsDir", this.draft.translationAssetsDir)}
      <div class="paper-manager-preview">自动删除仅在新翻译及元数据保存成功后执行；删除失败不会影响新版本。</div>`;
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
    if (!selected) { editor.innerHTML = ""; this.activeLibrary = undefined; this.libraryEditor = undefined; return; }
    this.activeLibrary = selected;
    this.libraryEditor = editor;
    const projectDocumentLabels = new Map<string, string>();
    await Promise.all(selected.data.projects.map(async (project) => {
      if (!project.docId) return;
      try {
        const doc = await this.kernel.getDocumentInfo(project.docId);
        if (doc) projectDocumentLabels.set(project.docId, documentLabel(doc));
      } catch { /* keep the stored ID visible */ }
    }));
    if (this.activeLibrary !== selected) return;
    editor.innerHTML = `<hr class="b3-hr"><h3>${escapeHtml(selected.title)}</h3>
      <div class="paper-manager-preview">${escapeHtml(selected.hPath)} · 数据库 ${escapeHtml(selected.data.avId)}</div>
      <section class="paper-manager-library-section"><h4>项目定义</h4>
        <p class="b3-label__text">保存后，项目名称会出现在本文献库「所属项目」的候选标签中，点击即可多选；可搜索并绑定一个思源项目文档。</p>
        <div class="paper-manager-project-list" data-project-list>${selected.data.projects.map((project) => projectRowHtml(
          project, project.docId ? projectDocumentLabels.get(project.docId) ?? project.docId : "",
        )).join("")}</div>
        <button type="button" class="b3-button b3-button--outline" data-project-add>添加项目</button>
      </section>
      <div class="paper-manager-preview">项目的修改会随右下角「保存」一起应用；列的显示与排序请直接在数据库视图中操作。</div>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>重新同步</button>
        <button type="button" class="b3-button b3-button--text" data-repair>修复数据库</button>
      </div>`;
    const projectList = editor.querySelector<HTMLElement>("[data-project-list]")!;
    for (const row of projectList.querySelectorAll<HTMLElement>("[data-project-row]")) bindProjectRow(row, this.kernel);
    editor.querySelector<HTMLButtonElement>("[data-project-add]")!.onclick = () => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = projectRowHtml({ id: newNodeId(), name: "" }, "");
      const row = wrapper.firstElementChild as HTMLElement;
      projectList.append(row);
      bindProjectRow(row, this.kernel);
      row.querySelector<HTMLInputElement>("[data-project-name]")?.focus();
    };
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
    // 设置框确认后可能立即卸载 DOM，必须在第一次 await 前读取项目草稿。
    const library = this.activeLibrary;
    const list = this.libraryEditor?.querySelector<HTMLElement>("[data-project-list]");
    const projects = list ? collectProjects(list) : undefined;
    try {
      const settings = normalizeSettings(this.draft);
      settings.onboardingCompleted = Boolean(settings.defaultLibraryDocId);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
    } catch (error) {
      showMessage(`设置保存失败：${message(error)}`, 5000, "error");
      return;
    }
    try {
      const applied = await this.applyLibraryChanges(library, projects);
      showMessage(applied ? `设置已保存；${applied}` : "论文管理设置已保存", 5000, "info");
    } catch (error) {
      showMessage(`设置已保存，但文献库改动应用失败：${message(error)}`, 7000, "error");
    }
  }

  /** 统一应用当前文献库编辑器的改动：项目定义。 */
  private async applyLibraryChanges(library?: PaperLibraryInfo, projects?: LibraryProject[]): Promise<string> {
    if (!library || !projects) return "";
    if (projectsEqual(projects, library.data.projects)) return "";
    await this.libraries.updateProjects(library.docId, projects);
    library.data.projects = projects;
    return "项目已保存";
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

function projectRowHtml(project: LibraryProject, document: string): string {
  return `<div class="paper-manager-project-row" data-project-row data-project-id="${escapeHtml(project.id)}">
    <input class="b3-text-field" data-project-name placeholder="项目名称" value="${escapeHtml(project.name)}">
    <div class="paper-manager-project-document">
      <input class="b3-text-field" data-project-search autocomplete="off" placeholder="搜索并绑定项目文档（可选）" value="${escapeHtml(document)}">
      <input type="hidden" data-project-doc-id value="${escapeHtml(project.docId ?? "")}">
      <div class="paper-manager-document-results" data-document-results hidden></div>
    </div>
    <a class="b3-button b3-button--text" data-project-open ${project.docId ? `href="siyuan://blocks/${escapeHtml(project.docId)}"` : "hidden"} title="打开绑定文档">↗</a>
    <button type="button" class="b3-button b3-button--text" data-project-clear title="清除文档绑定">清除</button>
    <button type="button" class="b3-button b3-button--text" data-project-remove title="删除项目">删除</button>
  </div>`;
}

function bindProjectRow(row: HTMLElement, kernel: KernelClient): void {
  const search = row.querySelector<HTMLInputElement>("[data-project-search]")!;
  const docId = row.querySelector<HTMLInputElement>("[data-project-doc-id]")!;
  const results = row.querySelector<HTMLElement>("[data-document-results]")!;
  const open = row.querySelector<HTMLAnchorElement>("[data-project-open]")!;
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const choose = (document: DocumentSearchResult) => {
    request += 1;
    if (timer) clearTimeout(timer);
    search.value = documentLabel(document);
    docId.value = document.id;
    open.href = `siyuan://blocks/${document.id}`;
    open.hidden = false;
    results.hidden = true;
  };
  search.oninput = () => {
    docId.value = "";
    open.hidden = true;
    if (timer) clearTimeout(timer);
    const current = ++request;
    const keyword = search.value.trim();
    if (!keyword) { results.hidden = true; results.innerHTML = ""; return; }
    timer = setTimeout(() => { void (async () => {
      try {
        const documents = await kernel.searchDocuments(keyword, 12);
        if (current !== request) return;
        results.innerHTML = documents.length
          ? documents.map((document) => `<button type="button" data-document-id="${escapeHtml(document.id)}"><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.hPath)}</small></button>`).join("")
          : "<span>没有匹配的文档</span>";
        results.hidden = false;
        for (const button of results.querySelectorAll<HTMLButtonElement>("[data-document-id]")) {
          button.onclick = () => {
            const document = documents.find((candidate) => candidate.id === button.dataset.documentId);
            if (document) choose(document);
          };
        }
      } catch (error) {
        if (current !== request) return;
        results.textContent = `搜索失败：${message(error)}`;
        results.hidden = false;
      }
    })(); }, 220);
  };
  search.onfocus = () => { if (results.childElementCount || results.textContent) results.hidden = false; };
  search.onblur = () => setTimeout(() => { results.hidden = true; }, 180);
  row.querySelector<HTMLButtonElement>("[data-project-clear]")!.onclick = () => {
    request += 1;
    if (timer) clearTimeout(timer);
    search.value = "";
    docId.value = "";
    open.hidden = true;
    results.hidden = true;
  };
  row.querySelector<HTMLButtonElement>("[data-project-remove]")!.onclick = () => row.remove();
}

function collectProjects(list: HTMLElement): LibraryProject[] {
  return Array.from(list.querySelectorAll<HTMLElement>("[data-project-row]"), (row) => ({
    id: row.dataset.projectId || newNodeId(),
    name: row.querySelector<HTMLInputElement>("[data-project-name]")!.value.trim(),
    docId: row.querySelector<HTMLInputElement>("[data-project-doc-id]")!.value.trim() || undefined,
  })).filter((project) => project.name);
}

function documentLabel(document: DocumentSearchResult): string {
  return `${document.title}${document.hPath ? ` · ${document.hPath}` : ""}`;
}

function projectsEqual(left: LibraryProject[], right: LibraryProject[]): boolean {
  return left.length === right.length && left.every((project, index) => {
    const other = right[index];
    return other && project.id === other.id && project.name === other.name
      && (project.docId ?? "") === (other.docId ?? "");
  });
}

async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`文献库操作失败：${message(error)}`, 7000, "error"); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
