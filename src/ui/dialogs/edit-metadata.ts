import { Dialog, showMessage } from "siyuan";
import { MetadataExtractor } from "../../services/metadata-extractor";
import type { ExtractionResult, MetadataCandidate } from "../../types/import";
import type { PaperCanonical, PaperData } from "../../types/paper";
import type { PluginSettings } from "../../types/settings";
import { button, escapeHtml } from "../dom";
import { generateCitekey, uniqueCitekey } from "../../core/naming";
import { candidatePreviewHtml } from "./paper-preview";

const fields: Array<[keyof PaperCanonical, string]> = [
  ["title", "标题"], ["url", "论文网址"],
  ["itemType", "文献类型"], ["date", "日期 / 年份"],
  ["doi", "DOI"], ["language", "语言"],
  ["journal", "期刊 / 书名"], ["publisher", "出版社 / 学校"],
  ["publisherPlace", "出版地"], ["pages", "页码"],
  ["volume", "卷"], ["issue", "期"], ["isbn", "ISBN"], ["issn", "ISSN"],
];
const authorsText = (c: PaperCanonical) => c.creators.map(a => [a.family, a.given].filter(Boolean).join(", ")).join("\n");

export async function openMetadataEditor(
  paper: PaperData, getSettings: () => PluginSettings, save: (draft: PaperCanonical, citekey: string) => Promise<void>,
  existingCitekeys: string[] = [],
): Promise<void> {
  const draft = structuredClone(paper.canonical);
  let controller: AbortController | undefined;
  let generation = 0;
  let saving = false;
  const pdfs = paper.attachments.filter(a => a.mimeType === "application/pdf" || /\.pdf$/i.test(a.assetAddress));
  const dialog = new Dialog({
    title: "元数据编辑", width: "780px",
    destroyCallback: () => { generation++; controller?.abort(); },
    content: `<div class="b3-dialog__content paper-manager-import paper-manager-metadata-editor"><div class="paper-manager-import-scroll paper-manager-form">
      <header class="paper-manager-editor-heading"><span class="paper-manager-hint">当前论文 · ${escapeHtml(paper.citekey)}</span><h3>${escapeHtml(paper.canonical.title)}</h3></header>
      <section class="paper-manager-import-section">
        <details><summary class="paper-manager-import-label">从 PDF / 网络获取元数据</summary><div class="paper-manager-editor-source">
          <label class="paper-manager-field paper-manager-field--column"><span>当前论文 PDF</span><select class="b3-select" data-pdf>${pdfs.length ? pdfs.map((a, i) => `<option value="${i}">${escapeHtml(a.title || a.assetAddress)}</option>`).join("") : '<option value="">暂无 PDF 附件，请选择本地文件</option>'}</select></label>
          <label class="paper-manager-field paper-manager-field--column"><span>或选择本地 PDF（仅用于识别）</span><input class="paper-manager-import-file" type="file" accept="application/pdf" data-local-pdf></label>
          <div class="paper-manager-actions" data-pdf-actions></div></div><div class="paper-manager-editor-source">
          <label class="paper-manager-field paper-manager-field--column"><span>标识符 / 论文网址 / BibTeX</span><textarea class="b3-text-field" rows="2" data-query placeholder="DOI、URL、arXiv、ISBN、PMID、PMCID 或 BibTeX"></textarea></label>
          <div class="paper-manager-import-lookup"><p class="paper-manager-hint">识别选项沿用「PDF 元数据」设置。结果需点击「应用候选」才会填入编辑表单，保存后生效。</p><div data-query-actions></div></div>
          </div><div class="paper-manager-editor-result" data-result hidden><label class="paper-manager-field paper-manager-field--column"><span>识别候选</span><select class="b3-select" data-candidates></select></label><section class="paper-manager-paper-preview" data-preview></section><div class="paper-manager-actions" data-candidate-actions></div></div>
        </details>
      </section>
      <div class="paper-manager-import-warnings" data-message role="status" hidden></div>
      <section class="paper-manager-import-section paper-manager-import-editor-fields" data-form>
        <label class="paper-manager-field paper-manager-field--column"><span>引用键（citekey）</span><input class="b3-text-field" data-citekey aria-label="引用键（citekey）" maxlength="120"></label>
        <div><div class="paper-manager-actions" data-citekey-actions></div><p class="paper-manager-hint">按设置中的格式，使用当前标题、年份和作者生成，重名时添加后缀。保存后同步引用键与文档名；已导出的引用需重新导出。</p></div>
        ${fields.map(([key, label]) => `<label class="paper-manager-field paper-manager-field--column" data-edit-field="${key}"><span>${label}</span>${key === "title" ? '<textarea class="b3-text-field" data-field="title" rows="2"></textarea>' : key === "itemType" ? '<select class="b3-select" data-field="itemType" aria-label="文献类型"></select>' : `<input class="b3-text-field" data-field="${key}">`}</label>`).join("") }
        <details class="paper-manager-editor-long" open><summary>作者</summary><p class="paper-manager-hint">每行一位，格式为「姓, 名」；中文姓名可直接填写。</p><textarea class="b3-text-field" data-field="creators" rows="3" aria-label="作者"></textarea></details>
        <details class="paper-manager-editor-long"><summary>摘要</summary><textarea class="b3-text-field" data-field="abstract" rows="6" aria-label="摘要"></textarea></details>
        <details class="paper-manager-editor-long"><summary>标签</summary><textarea class="b3-text-field" data-field="tags" rows="3" aria-label="标签（每行一项）"></textarea></details>
      </section>
      </div><div class="paper-manager-import-footer"><span class="paper-manager-hint">保存到当前论文及所属数据库</span><div class="paper-manager-actions" data-actions></div></div></div>`,
  });
  const root = dialog.element;
  const controls = () => root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-field]");
  const fill = () => controls().forEach(e => {
    const key = e.dataset.field as keyof PaperCanonical;
    if (key === "itemType") {
      const types: Record<string, string> = { journalArticle: "期刊论文", conferencePaper: "会议论文", thesis: "学位论文", preprint: "预印本", book: "图书", bookSection: "图书章节", report: "报告", webpage: "网页" };
      if (draft.itemType && !Object.hasOwn(types, draft.itemType)) types[draft.itemType] = draft.itemType;
      e.innerHTML = Object.entries(types).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}（${escapeHtml(value)}）</option>`).join("");
    }
    e.value = key === "creators" ? authorsText(draft) : key === "tags" ? draft.tags.join("\n") : String(draft[key] ?? "");
  });
  const capture = () => controls().forEach(e => {
    const key = e.dataset.field as keyof PaperCanonical;
    if (key === "creators") {
      if (e.value !== authorsText(draft)) draft.creators = e.value.split("\n").map(n => n.trim()).filter(Boolean).map(n => {
        const [family, ...given] = n.split(",");
        return { family: family!.trim(), given: given.join(",").trim(), creatorType: "author" };
      });
    } else if (key === "tags") draft.tags = e.value.split("\n").map(t => t.trim()).filter(Boolean);
    else if (e.value !== String(draft[key] ?? "")) Object.assign(draft, { [key]: e.value.trim() || (key === "title" || key === "itemType" ? "" : undefined) });
  });
  fill();
  const citekey = root.querySelector<HTMLInputElement>("[data-citekey]")!;
  citekey.value = paper.citekey;
  const regenerate = button("重新生成引用键");
  root.querySelector("[data-citekey-actions]")!.append(regenerate);
  regenerate.onclick = () => {
    capture();
    citekey.value = uniqueCitekey(generateCitekey(draft, getSettings().citekeyFormat), existingCitekeys);
  };
  const message = root.querySelector<HTMLElement>("[data-message]")!;
  const tell = (text: string) => { message.hidden = !text; message.textContent = text; };
  const local = root.querySelector<HTMLInputElement>("[data-local-pdf]")!;
  const pdf = root.querySelector<HTMLSelectElement>("[data-pdf]")!;
  const query = root.querySelector<HTMLTextAreaElement>("[data-query]")!;
  query.value = draft.doi || draft.url || "";
  const extract = button("提取元数据");
  const lookup = button("检索 / 解析");
  const apply = button("应用候选", true);
  const saveButton = button("保存元数据", true);
  const cancel = button("取消");
  root.querySelector("[data-pdf-actions]")!.append(extract);
  root.querySelector("[data-query-actions]")!.append(lookup);
  root.querySelector("[data-candidate-actions]")!.append(apply);
  root.querySelector("[data-actions]")!.append(cancel, saveButton);
  let candidates: MetadataCandidate[] = [];
  const select = root.querySelector<HTMLSelectElement>("[data-candidates]")!;
  const preview = () => { const c = candidates[Number(select.value)]; if (c) root.querySelector("[data-preview]")!.innerHTML = candidatePreviewHtml(c); };
  select.onchange = preview;
  apply.onclick = () => {
    capture();
    const c = candidates[Number(select.value)];
    if (!c) return;
    for (const [key, value] of Object.entries(c.canonical)) {
      if (value !== undefined && value !== "" && (!Array.isArray(value) || value.length)) Object.assign(draft, { [key]: structuredClone(value) });
    }
    fill(); tell("候选已填入表单，请核对后保存。空缺字段保留原值。");
  };
  const busy = (value: boolean) => {
    extract.disabled = value || (!pdfs.length && !local.files?.length);
    lookup.disabled = apply.disabled = saveButton.disabled = value;
  };
  const run = async (work: (extractor: MetadataExtractor, signal: AbortSignal) => Promise<ExtractionResult>) => {
    if (saving) return;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, request = ++generation;
    busy(true); tell("正在获取元数据…");
    const settings = getSettings();
    try {
      const result = await work(new MetadataExtractor({ signal, enableCnki: settings.enableCnki, cnkiRegion: settings.cnkiRegion,
        cnkiTimeoutSeconds: settings.cnkiTimeoutSeconds, enableZoteroRecognizer: settings.enableZoteroRecognizer }), signal);
      if (request !== generation || signal.aborted) return;
      candidates = result.candidates.includes(result.selected) ? result.candidates : [result.selected, ...result.candidates];
      select.innerHTML = candidates.map((c, i) => `<option value="${i}">${escapeHtml(c.provider)} · ${escapeHtml(c.canonical.title)}</option>`).join("");
      select.value = String(Math.max(0, candidates.indexOf(result.selected)));
      root.querySelector<HTMLElement>("[data-result]")!.hidden = false;
      preview(); tell(result.warnings.join("；"));
    } catch (error) { if (request === generation && !signal.aborted) tell(`获取失败：${error instanceof Error ? error.message : String(error)}。原编辑内容仍保留。`); }
    finally { if (request === generation) busy(false); }
  };
  extract.onclick = () => void run(async (extractor, signal) => {
    const file = local.files?.[0];
    if (file) return extractor.extract(new Uint8Array(await file.arrayBuffer()), file.name);
    const attachment = pdfs[Number(pdf.value)];
    if (!attachment) throw new Error("请选择 PDF");
    const path = attachment.assetAddress.replace(/^\//, "");
    if (!path.startsWith("assets/") || path.split("/").includes("..")) throw new Error("PDF 附件路径无效");
    const response = await fetch(new URL(path, `${location.origin}/`), { signal });
    if (!response.ok) throw new Error(`读取 PDF 失败：HTTP ${response.status}`);
    return extractor.extract(new Uint8Array(await response.arrayBuffer()), attachment.title || path.split("/").pop()!);
  });
  lookup.onclick = () => { if (!query.value.trim()) { tell("请输入标识符、论文网址或 BibTeX"); return; } void run(extractor => extractor.lookup(query.value)); };
  local.onchange = () => { controller?.abort(); generation++; busy(false); if (local.files?.length && getSettings().autoExtractMetadata) extract.click(); };
  pdf.onchange = () => { controller?.abort(); generation++; local.value = ""; busy(false); };
  cancel.onclick = () => { if (!saving) dialog.destroy(); };
  saveButton.onclick = async () => {
    capture();
    if (!draft.title.trim() || !draft.itemType.trim()) { tell("标题和文献类型不能为空"); return; }
    saving = true; busy(true); cancel.disabled = true;
    controls().forEach(e => e.disabled = true);
    local.disabled = pdf.disabled = query.disabled = true;
    citekey.disabled = regenerate.disabled = true;
    try { await save(structuredClone(draft), citekey.value.trim()); showMessage("论文元数据已保存，数据库和摘要已同步"); dialog.destroy(); }
    catch (error) { tell(`保存未完成：${error instanceof Error ? error.message : String(error)}`); }
    finally { saving = false; busy(false); cancel.disabled = false; controls().forEach(e => e.disabled = false); local.disabled = pdf.disabled = query.disabled = false; citekey.disabled = regenerate.disabled = false; }
  };
  busy(false);
}
