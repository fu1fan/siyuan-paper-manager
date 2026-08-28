import { Dialog } from "siyuan";
import type { DuplicateMatch, DuplicateResolution, PaperData } from "../../types/paper";
import { button, escapeHtml } from "../dom";

export function resolveDuplicateDialog(match: DuplicateMatch, incoming: PaperData): Promise<DuplicateResolution> {
  return new Promise((resolve) => {
    let completed = false;
    const finish = (result: DuplicateResolution, dialog: Dialog) => {
      if (completed) return;
      completed = true;
      resolve(result);
      dialog.destroy();
    };
    const reason = match.reason === "doi"
      ? "DOI 相同"
      : match.reason === "citekey-conflict"
        ? "citekey 相同，但 DOI 或标题疑似冲突"
        : "citekey 与标题相同";
    const rows = match.conflicts.map((conflict) => `
      <label>
        <input type="checkbox" data-field="${escapeHtml(conflict.field)}">
        <strong>${escapeHtml(fieldLabel(conflict.field))}</strong><br>
        <small>现有：${escapeHtml(display(conflict.existing))}</small><br>
        <small>传入：${escapeHtml(display(conflict.incoming))}</small>
      </label>`).join("");
    const dialog = new Dialog({
      title: "检测到重复论文",
      width: "680px",
      content: `<div class="b3-dialog__content">
        <p><strong>${escapeHtml(reason)}</strong></p>
        <p>现有：${escapeHtml(match.existing.canonical.title)}<br>传入：${escapeHtml(incoming.canonical.title)}</p>
        <p>默认合并只填补空字段、补充去重后的附件，不覆盖阅读笔记。勾选下列字段才会用传入值覆盖：</p>
        <div class="paper-manager-conflicts">${rows || "<p>没有字段冲突。</p>"}</div>
        <div class="paper-manager-actions" data-actions></div>
      </div>`,
      destroyCallback: () => {
        if (!completed) { completed = true; resolve({ action: "cancel" }); }
      },
    });
    const actions = dialog.element.querySelector<HTMLElement>("[data-actions]")!;
    const cancel = button("取消");
    const copy = button("新建副本");
    const merge = button("合并", true);
    cancel.addEventListener("click", () => finish({ action: "cancel" }, dialog));
    copy.addEventListener("click", () => finish({ action: "copy" }, dialog));
    merge.addEventListener("click", () => {
      const overwrite = Array.from(dialog.element.querySelectorAll<HTMLInputElement>("input[data-field]:checked"))
        .map((input) => input.dataset.field!) as DuplicateResolution extends { action: "merge"; overwrite: infer T } ? T : never;
      finish({ action: "merge", overwrite }, dialog);
    });
    actions.append(cancel, copy, merge);
  });
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("；");
  return String(value ?? "");
}

function fieldLabel(field: string): string {
  return ({
    itemType: "类型", title: "标题", creators: "作者", date: "日期", abstract: "摘要",
    doi: "DOI", isbn: "ISBN", issn: "ISSN", url: "URL", journal: "期刊/书名",
    volume: "卷", issue: "期", pages: "页码", publisher: "出版社", language: "语言", tags: "标签",
  } as Record<string, string>)[field] ?? field;
}
