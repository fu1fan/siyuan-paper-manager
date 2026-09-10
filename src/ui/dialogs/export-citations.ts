import { Dialog, showMessage } from "siyuan";
import { CITATION_FORMAT_LABELS, exportCitations, type CitationExportFormat } from "../../services/citation-export";
import type { LibraryService, LibraryPaperRecord, PaperLibraryInfo } from "../../services/library-service";
import { button, escapeHtml } from "../dom";

/**
 * 导出引用对话框：任何文档都能打开，文献库在对话框内选择。
 * preferredDocId 是当前文档：本身是文献库则预选它；是论文页则预选其所属文献库。
 */
export async function openCitationExportDialog(libraries: LibraryService, preferredDocId?: string): Promise<void> {
  const all = await libraries.discoverLibraries();
  if (!all.length) {
    showMessage("还没有论文文献库，请先在设置中完成初始化", 5000, "error");
    return;
  }
  let initialId = all[0]!.docId;
  if (preferredDocId) {
    if (all.some((library) => library.docId === preferredDocId)) {
      initialId = preferredDocId;
    } else {
      const entry = await libraries.findPaperEntry(preferredDocId);
      if (entry) initialId = entry.library.docId;
    }
  }

  const dialog = new Dialog({
    title: "导出引用",
    width: "960px",
    content: `<div class="b3-dialog__content paper-manager-form paper-manager-export">
      <div class="paper-manager-export-toolbar">
        <label class="paper-manager-field paper-manager-field--column"><span>文献库</span><select class="b3-select" data-library title="文献库">${all.map((library) => `<option value="${escapeHtml(library.docId)}">${escapeHtml(library.title)}</option>`).join("")}</select></label>
        <label class="paper-manager-field paper-manager-field--column"><span>搜索论文</span><input class="b3-text-field" data-search placeholder="搜索标题、作者、DOI 或引用键"></label>
        <label class="paper-manager-field paper-manager-field--column"><span>所属项目</span><select class="b3-select" data-project></select></label>
        <label class="paper-manager-field paper-manager-field--column"><span>引用格式</span><select class="b3-select" data-format>${Object.entries(CITATION_FORMAT_LABELS).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select></label>
      </div>
      <div class="paper-manager-export-body">
        <div class="paper-manager-export-side">
          <div class="paper-manager-export-side-bar">
            <span data-count></span>
            <span class="paper-manager-export-side-actions">
              <button type="button" class="b3-button b3-button--text" data-select-visible>选择当前结果</button><button type="button" class="b3-button b3-button--text" data-clear>清空</button>
            </span>
          </div>
          <div class="paper-manager-export-list" data-list></div>
        </div>
        <textarea class="b3-text-field paper-manager-export-output" aria-label="引用预览" readonly data-output></textarea>
      </div>
      <div class="paper-manager-export-footer">
        <span class="paper-manager-hint" data-warnings></span>
        <span class="paper-manager-export-footer-actions" data-actions></span>
      </div>
    </div>`,
  });
  const list = dialog.element.querySelector<HTMLElement>("[data-list]")!;
  const output = dialog.element.querySelector<HTMLTextAreaElement>("[data-output]")!;
  const warnings = dialog.element.querySelector<HTMLElement>("[data-warnings]")!;
  const count = dialog.element.querySelector<HTMLElement>("[data-count]")!;
  const search = dialog.element.querySelector<HTMLInputElement>("[data-search]")!;
  const librarySelect = dialog.element.querySelector<HTMLSelectElement>("[data-library]")!;
  const project = dialog.element.querySelector<HTMLSelectElement>("[data-project]")!;
  const format = dialog.element.querySelector<HTMLSelectElement>("[data-format]")!;

  let library: PaperLibraryInfo = all.find((candidate) => candidate.docId === initialId)!;
  let records: LibraryPaperRecord[] = [];
  let selected = new Set<string>();
  let visible: LibraryPaperRecord[] = [];

  const refreshOutput = () => {
    const chosen = records.filter((record) => selected.has(record.docId)).map((record) => record.paper);
    const result = exportCitations(chosen, format.value as CitationExportFormat);
    output.value = result.content;
    output.dataset.extension = result.extension;
    output.dataset.mime = result.mimeType;
    warnings.textContent = result.warnings.length ? `提示：${result.warnings.join("；")}` : `${chosen.length} 篇文献已就绪`;
  };
  const renderList = () => {
    const query = search.value.trim().toLocaleLowerCase();
    visible = records.filter((record) => {
      const c = record.paper.canonical;
      const text = [c.title, c.doi, record.paper.citekey, ...c.creators.map((creator) => `${creator.family} ${creator.given}`)].join(" ").toLocaleLowerCase();
      return (!query || text.includes(query)) && (!project.value || record.projectNames.includes(project.value));
    });
    list.innerHTML = visible.length ? visible.map((record) => `<label class="paper-manager-export-row"><input type="checkbox" data-doc-id="${escapeHtml(record.docId)}" ${selected.has(record.docId) ? "checked" : ""}><span><strong>${escapeHtml(record.paper.canonical.title || record.paper.citekey)}</strong><small>${escapeHtml(record.paper.citekey)} · ${escapeHtml(record.paper.canonical.date ?? "无年份")}</small></span></label>`).join("") : "<div class=\"paper-manager-preview paper-manager-export-empty\">没有匹配的论文。</div>";
    for (const checkbox of list.querySelectorAll<HTMLInputElement>("[data-doc-id]")) checkbox.onchange = () => {
      if (checkbox.checked) selected.add(checkbox.dataset.docId!); else selected.delete(checkbox.dataset.docId!);
      refreshOutput();
    };
    count.textContent = `已选 ${selected.size} / ${records.length} 篇`;
    refreshOutput();
  };
  const loadLibrary = async (docId: string) => {
    list.innerHTML = "<div class=\"paper-manager-preview\">正在加载…</div>";
    output.value = "";
    library = await libraries.getLibrary(docId);
    records = await libraries.listPapers(docId);
    selected = new Set(records.map((record) => record.docId));
    search.value = "";
    const projectNames = [...new Set(records.flatMap((record) => record.projectNames))];
    project.innerHTML = `<option value="">全部项目</option>${projectNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    renderList();
  };
  librarySelect.value = initialId;
  librarySelect.onchange = () => void loadLibrary(librarySelect.value).catch((error) => {
    showMessage(`文献库加载失败：${error instanceof Error ? error.message : String(error)}`, 6000, "error");
  });
  search.oninput = renderList;
  project.onchange = renderList;
  format.onchange = refreshOutput;
  dialog.element.querySelector<HTMLButtonElement>("[data-select-visible]")!.onclick = () => { for (const record of visible) selected.add(record.docId); renderList(); };
  dialog.element.querySelector<HTMLButtonElement>("[data-clear]")!.onclick = () => { selected.clear(); renderList(); };

  const cancel = button("关闭");
  const copy = button("复制", false);
  const download = button("下载文件", true);
  cancel.onclick = () => dialog.destroy();
  copy.onclick = async () => {
    await navigator.clipboard.writeText(output.value);
    showMessage("引用已复制", 3000, "info");
  };
  download.onclick = () => {
    const blob = new Blob([output.value], { type: output.dataset.mime ?? "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(library.title)}-references.${output.dataset.extension ?? "txt"}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  dialog.element.querySelector<HTMLElement>("[data-actions]")!.append(cancel, copy, download);
  await loadLibrary(initialId);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "library";
}
