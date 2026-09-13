import type { PaperData } from "../../types/paper";
import { attachmentState, originalPdfCandidates, type AttachmentEdit, type AttachmentState, type PendingAttachment } from "../../services/attachments";
import { safeAssetUrl } from "../../core/normalize";
import { escapeHtml } from "../dom";

export function mountAttachmentEditor(host: HTMLElement, paper: PaperData, changed: () => void, initialFiles: Map<string, File> = new Map()) {
  const baseline = attachmentState(paper);
  let draft = attachmentState(paper);
  let disabled = false;
  let sequence = 0;
  const files = new Map(initialFiles);
  const pending = new Map<string, PendingAttachment>();
  const history: AttachmentState[] = [];
  const remember = () => history.push(attachmentState(draft));
  host.innerHTML = `<div class="paper-manager-attachment-heading"><h3>附件管理</h3><span class="paper-manager-hint" data-count></span></div>
    <p class="paper-manager-hint">名称用于论文内显示。删除仅移除当前论文的引用；资源文件可由思源清理未使用资源。所有更改保存后生效。</p>
    <div class="paper-manager-attachment-list" data-attachment-list></div>
    <div class="paper-manager-attachment-add"><label>添加为 <select class="b3-select" data-add-kind aria-label="新增附件类型"><option value="attachment">普通附件 / 网页快照</option><option value="mono">单语译稿</option><option value="dual">双语译稿</option></select></label>
      <button class="b3-button b3-button--outline" type="button" data-add>添加附件</button><input type="file" multiple data-attachment-files hidden>
      <button class="b3-button b3-button--cancel" type="button" data-undo hidden>撤销上次附件操作</button></div>
    <label class="paper-manager-field paper-manager-field--column"><span>论文原稿（用于翻译）</span><select class="b3-select" data-original-pdf aria-label="论文原稿（用于翻译）"></select></label>
    <p class="paper-manager-hint" data-original-hint></p><p class="paper-manager-import-warnings" data-attachment-error role="status" hidden></p>`;
  const list = host.querySelector<HTMLElement>("[data-attachment-list]")!;
  const original = host.querySelector<HTMLSelectElement>("[data-original-pdf]")!;
  const input = host.querySelector<HTMLInputElement>("[data-attachment-files]")!;
  const kind = host.querySelector<HTMLSelectElement>("[data-add-kind]")!;
  const error = host.querySelector<HTMLElement>("[data-attachment-error]")!;
  const tell = (text: string) => { error.textContent = text; error.hidden = !text; };
  const translationTitle = (type: "mono" | "dual") => draft.translation[type === "mono" ? "monoTitle" : "dualTitle"] || (type === "mono" ? "单语翻译版" : "双语对照版");
  const entries = () => [
    ...draft.attachments.map(item => ({ item, type: "attachment" as const })),
    ...(["mono", "dual"] as const).flatMap(type => draft.translation[type] ? [{ type, item: {
      title: translationTitle(type), assetAddress: draft.translation[type]!, mimeType: "application/pdf", sha256: "",
    } }] : []),
  ];
  const refreshOriginal = () => {
    const pdfs = originalPdfCandidates(draft);
    original.innerHTML = `<option value="">${pdfs.length === 1 ? "自动使用唯一的 PDF" : pdfs.length ? "请选择论文原稿" : "暂无可用 PDF"}</option>`
      + pdfs.map(item => `<option value="${escapeHtml(item.assetAddress)}">${escapeHtml(item.title)}</option>`).join("");
    original.value = draft.originalPdf ?? "";
    host.querySelector<HTMLElement>("[data-original-hint]")!.textContent = pdfs.length > 1 && !draft.originalPdf
      ? "有多个 PDF，指定原稿后才能翻译。译稿不会作为原稿候选。"
      : "翻译和 PDF 元数据识别默认使用该原稿。更换原稿不会自动重新生成已有译稿。";
  };
  const render = () => {
    const rows = entries();
    host.querySelector<HTMLElement>("[data-count]")!.textContent = `${rows.length} 个附件`;
    list.innerHTML = rows.length ? rows.map(({ item, type }, index) => {
      const url = safeAssetUrl(item.assetAddress);
      const label = type === "mono" ? "单语译稿" : type === "dual" ? "双语译稿" : item.mimeType === "text/html" || /\.html?$/i.test(item.assetAddress) ? "网页快照" : "附件";
      return `<div class="paper-manager-attachment-row"><div class="paper-manager-attachment-main"><label><span class="paper-manager-attachment-kind">${label}</span><input class="b3-text-field" data-attachment-name="${index}" aria-label="${label}名称 ${index + 1}" value="${escapeHtml(item.title)}" maxlength="200"></label>
        <span class="paper-manager-hint paper-manager-attachment-path" title="${escapeHtml(item.assetAddress)}">${item.assetAddress.startsWith("pending:") ? "待保存上传" : escapeHtml(item.assetAddress)}</span></div>
        <div class="paper-manager-actions">${url ? `<a class="b3-button b3-button--outline" href="/${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">打开</a>` : ""}<button type="button" class="b3-button b3-button--cancel" data-attachment-delete="${index}" aria-label="删除${escapeHtml(item.title)}">删除</button></div></div>`;
    }).join("") : '<p class="paper-manager-hint">暂无附件，可添加 PDF、网页快照或其他文件。</p>';
    list.querySelectorAll<HTMLInputElement>("[data-attachment-name]").forEach(control => {
      control.onchange = () => {
        const row = rows[Number(control.dataset.attachmentName)]!;
        if (!control.value.trim()) { tell("附件名称不能为空"); control.value = row.item.title; return; }
        remember();
        if (row.type === "attachment") row.item.title = control.value.trim();
        else draft.translation[row.type === "mono" ? "monoTitle" : "dualTitle"] = control.value.trim();
        tell(""); host.querySelector<HTMLButtonElement>("[data-undo]")!.hidden = false; refreshOriginal(); changed();
      };
    });
    list.querySelectorAll<HTMLButtonElement>("[data-attachment-delete]").forEach(control => {
      control.onclick = () => {
        remember();
        const row = rows[Number(control.dataset.attachmentDelete)]!;
        if (row.type === "attachment") draft.attachments = draft.attachments.filter(item => item.assetAddress !== row.item.assetAddress);
        else { delete draft.translation[row.type]; delete draft.translation[row.type === "mono" ? "monoTitle" : "dualTitle"]; }
        if (draft.originalPdf === row.item.assetAddress) draft.originalPdf = undefined;
        tell(""); render(); changed();
      };
    });
    host.querySelector<HTMLButtonElement>("[data-undo]")!.hidden = !history.length;
    refreshOriginal(); setDisabled(disabled);
  };
  function setDisabled(value: boolean) {
    disabled = value;
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button").forEach(control => control.disabled = value);
  }
  original.onchange = () => { remember(); draft.originalPdf = original.value || undefined; render(); changed(); };
  host.querySelector<HTMLButtonElement>("[data-undo]")!.onclick = () => { const previous = history.pop(); if (previous) draft = previous; tell(""); render(); changed(); };
  host.querySelector<HTMLButtonElement>("[data-add]")!.onclick = () => {
    input.accept = kind.value === "attachment" ? "" : "application/pdf,.pdf";
    input.multiple = kind.value === "attachment";
    input.click();
  };
  input.onchange = () => {
    const selected = Array.from(input.files ?? []); input.value = "";
    if (!selected.length) return;
    const type = kind.value as "attachment" | "mono" | "dual";
    if (type !== "attachment" && draft.translation[type]) { tell("请先删除现有的对应译稿，再添加替代文件。也可将文件作为普通附件添加。"); return; }
    if (type !== "attachment" && (selected.length !== 1 || !/\.pdf$/i.test(selected[0]!.name))) { tell("译稿须为一个 PDF 文件"); return; }
    remember();
    for (const file of selected) {
      const id = `pending:local-${++sequence}`;
      files.set(id, file);
      if (type === "attachment") draft.attachments.push({ title: file.name, assetAddress: id, mimeType: file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : /\.html?$/i.test(file.name) ? "text/html" : "application/octet-stream"), sha256: "" });
      else { draft.translation[type] = id; draft.translation[type === "mono" ? "monoTitle" : "dualTitle"] = file.name; }
    }
    tell(""); render(); changed();
  };
  render();
  return {
    setDisabled,
    addIncoming(address: string, file: File) {
      if (files.has(address)) return;
      files.set(address, file);
      const item = { title: file.name, assetAddress: address, mimeType: file.type, sha256: "" };
      draft.attachments.push(item);
      for (const state of history) state.attachments.push({ ...item });
      render(); changed();
    },
    getState: () => attachmentState(draft),
    getFile: (address: string) => files.get(address),
    async getEdit(): Promise<AttachmentEdit> {
      for (const { item } of entries()) {
        const file = files.get(item.assetAddress);
        if (!file || pending.has(item.assetAddress)) continue;
        pending.set(item.assetAddress, { id: item.assetAddress, bytes: new Uint8Array(await file.arrayBuffer()), title: file.name, mimeType: item.mimeType });
      }
      return { baseline, draft: attachmentState(draft), additions: [...pending.values()] };
    },
  };
}
