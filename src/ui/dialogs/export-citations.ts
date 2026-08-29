import { Dialog, showMessage } from "siyuan";
import { CITATION_FORMAT_LABELS, exportCitations, type CitationExportFormat } from "../../services/citation-export";
import type { LibraryService, LibraryPaperRecord } from "../../services/library-service";
import { button, escapeHtml } from "../dom";

export async function openCitationExportDialog(libraryDocId: string, libraries: LibraryService): Promise<void> {
  const library = await libraries.getLibrary(libraryDocId);
  const records = await libraries.listPapers(libraryDocId);
  const dialog = new Dialog({
    title: `导出引用 · ${library.title}`,
    width: "920px",
    content: `<div class="b3-dialog__content paper-manager-form paper-manager-export">
      <div class="paper-manager-export-toolbar">
        <input class="b3-text-field" data-search placeholder="搜索标题、作者、DOI 或引用键">
        <select class="b3-select" data-project><option value="">全部项目</option>${library.data.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select>
        <select class="b3-select" data-format>${Object.entries(CITATION_FORMAT_LABELS).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>
      </div>
      <div class="paper-manager-export-projects">${library.data.projects.filter((project) => project.docId).map((project) => `<a href="siyuan://blocks/${escapeHtml(project.docId!)}">${escapeHtml(project.name)} ↗</a>`).join(" · ")}</div>
      <div class="paper-manager-export-list" data-list></div>
      <div class="paper-manager-actions"><button type="button" class="b3-button b3-button--text" data-select-visible>选择当前结果</button><button type="button" class="b3-button b3-button--text" data-clear>清空选择</button></div>
      <textarea class="b3-text-field paper-manager-export-output" rows="14" readonly data-output></textarea>
      <div class="paper-manager-preview" data-warnings></div>
      <div class="paper-manager-actions" data-actions></div>
    </div>`,
  });
  const selected = new Set(records.map((record) => record.docId));
  let visible: LibraryPaperRecord[] = records;
  const list = dialog.element.querySelector<HTMLElement>("[data-list]")!;
  const output = dialog.element.querySelector<HTMLTextAreaElement>("[data-output]")!;
  const warnings = dialog.element.querySelector<HTMLElement>("[data-warnings]")!;
  const search = dialog.element.querySelector<HTMLInputElement>("[data-search]")!;
  const project = dialog.element.querySelector<HTMLSelectElement>("[data-project]")!;
  const format = dialog.element.querySelector<HTMLSelectElement>("[data-format]")!;

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
      return (!query || text.includes(query)) && (!project.value || record.paper.projectIds.includes(project.value));
    });
    list.innerHTML = visible.length ? visible.map((record) => `<label class="paper-manager-export-row"><input type="checkbox" data-doc-id="${escapeHtml(record.docId)}" ${selected.has(record.docId) ? "checked" : ""}><span><strong>${escapeHtml(record.paper.canonical.title)}</strong><small>${escapeHtml(record.paper.citekey)} · ${escapeHtml(record.paper.canonical.date ?? "无年份")}</small></span></label>`).join("") : "<div class=\"paper-manager-preview\">没有匹配的论文。</div>";
    for (const checkbox of list.querySelectorAll<HTMLInputElement>("[data-doc-id]")) checkbox.onchange = () => {
      if (checkbox.checked) selected.add(checkbox.dataset.docId!); else selected.delete(checkbox.dataset.docId!);
      refreshOutput();
    };
    refreshOutput();
  };
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
  renderList();
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "library";
}
