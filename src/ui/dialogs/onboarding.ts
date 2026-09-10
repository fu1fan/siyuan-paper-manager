import { Dialog, showMessage } from "siyuan";
import type { KernelClient } from "../../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../../services/library-service";
import { button, escapeHtml, inputValue } from "../dom";

export async function openOnboardingDialog(
  kernel: KernelClient,
  libraries: LibraryService,
  onCreated: (library: PaperLibraryInfo) => Promise<void>,
  title = "初始化论文文献库",
): Promise<void> {
  const notebooks = await kernel.listNotebooks();
  if (!notebooks.length) throw new Error("请先在思源中新建并打开一个笔记本");
  const dialog = new Dialog({
    title,
    width: "680px",
    content: `<div class="b3-dialog__content paper-manager-dialog">
      <div class="paper-manager-dialog-scroll paper-manager-form"><p class="paper-manager-hint">文献库是一个真实文档，插件会在其中插入思源数据库；导入的论文会成为该文档的子文档。</p>
      <label class="paper-manager-field"><span>笔记本</span><select class="b3-select" data-notebook>${notebooks.map((notebook) =>
        `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.name)}</option>`).join("")}</select></label>
      <label class="paper-manager-field"><span>文献库名称</span><input class="b3-text-field" data-title value="论文文献库"></label>
      <label class="paper-manager-field"><span>文档路径</span><input class="b3-text-field" data-path value="/论文文献库"></label>
      </div><div class="paper-manager-dialog-footer"><div class="paper-manager-actions" data-actions></div></div>
    </div>`,
  });
  const actions = dialog.element.querySelector<HTMLElement>("[data-actions]")!;
  const cancel = button("稍后设置");
  const create = button("创建并设为默认", true);
  cancel.addEventListener("click", () => dialog.destroy());
  create.addEventListener("click", async () => {
    create.disabled = true;
    create.textContent = "正在创建数据库…";
    try {
      const notebookId = inputValue(dialog.element, "[data-notebook]");
      const libraryTitle = inputValue(dialog.element, "[data-title]") || "论文文献库";
      const hPath = normalizePath(inputValue(dialog.element, "[data-path]") || `/${libraryTitle}`);
      const library = await libraries.createLibrary(notebookId, hPath, libraryTitle);
      await onCreated(library);
      showMessage("论文文献库已创建", 4000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`创建文献库失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
      create.disabled = false;
      create.textContent = "创建并设为默认";
    }
  });
  actions.append(cancel, create);
}

function normalizePath(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/\.{2,}/g, "").replace(/\/+$/, "");
  return clean.startsWith("/") ? clean : `/${clean}`;
}
