import { Dialog, showMessage } from "siyuan";
import { SOURCE } from "../../constants";
import type { ItemProcessor } from "../../services/item-processor";
import { MetadataExtractor } from "../../services/metadata-extractor";
import type { MetadataCandidate } from "../../types/import";
import type { PluginSettings } from "../../types/settings";
import { candidatePreviewHtml } from "./paper-preview";
import { button, escapeHtml } from "../dom";

export async function openImportPdfDialog(
  processor: ItemProcessor,
  getSettings: () => PluginSettings,
): Promise<void> {
  let extractionController: AbortController | undefined;
  const dialog = new Dialog({
    destroyCallback: () => extractionController?.abort(),
    title: "检索论文 / 导入 PDF",
    width: "720px",
    content: `<div class="b3-dialog__content paper-manager-import"><div class="paper-manager-import-scroll paper-manager-form">
      <section class="paper-manager-import-section">
        <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">PDF 文件 <span class="paper-manager-import-optional">（可选）</span></span><input class="paper-manager-import-file" type="file" accept="application/pdf" data-file></label>
        <div class="paper-manager-import-lookup"><p class="paper-manager-import-hint">可手动提取或重新联网获取元数据；自动提取及 Zotero 识别选项在插件设置中调整。</p><div data-extract-action></div></div>
      </section>
      <section class="paper-manager-import-section">
        <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">标识符 / 论文网址 / BibTeX</span><textarea class="b3-text-field" data-query rows="2" placeholder="粘贴 DOI、URL、arXiv、ISBN、PMID、PMCID 或 BibTeX"></textarea></label>
        <div class="paper-manager-import-lookup"><p class="paper-manager-import-hint">检索会将标识符或网址发送给开放元数据接口；BibTeX 在本地解析。</p><div data-lookup-action></div></div>
      </section>
      <section class="paper-manager-import-section paper-manager-import-results">
      <label class="paper-manager-field paper-manager-field--column"><span class="paper-manager-import-label">识别候选</span><select class="b3-select" data-candidates disabled><option>选择 PDF 或输入标识符后开始识别</option></select></label>
      <section class="paper-manager-paper-preview" data-preview aria-live="polite">选择 PDF 或检索论文后，在这里预览元数据。</section>
      <div class="paper-manager-import-warnings" data-warnings role="status" hidden></div>
      <details class="paper-manager-import-editor"><summary>编辑元数据（导入时使用）</summary>
      <div class="paper-manager-import-editor-fields">${[ ["title", "标题"], ["authors", "作者（每行一位，姓, 名）"], ["date", "日期"], ["doi", "DOI"], ["url", "URL"], ["journal", "期刊 / 会议"], ["abstract", "摘要"] ].map(([key, label]) => `<label class="paper-manager-field paper-manager-field--column" data-edit-field="${key}"><span>${label}</span><textarea class="b3-text-field" data-edit="${key}" rows="${key === "abstract" ? 4 : 2}"></textarea></label>`).join("")}</div>
      </details>
      </section>
      </div><div class="paper-manager-import-footer"><span class="paper-manager-import-hint">将导入当前默认论文文献库</span><div class="paper-manager-actions" data-actions></div></div>
    </div>`,
  });
  const fileInput = dialog.element.querySelector<HTMLInputElement>("[data-file]")!;
  const extractButton = button("提取元数据");
  extractButton.disabled = true;
  dialog.element.querySelector("[data-extract-action]")!.append(extractButton);
  const candidateSelect = dialog.element.querySelector<HTMLSelectElement>("[data-candidates]")!;
  const preview = dialog.element.querySelector<HTMLElement>("[data-preview]")!;
  const warningBox = dialog.element.querySelector<HTMLElement>("[data-warnings]")!;
  const setWarnings = (warnings: string[]) => {
    warningBox.hidden = !warnings.length;
    warningBox.textContent = warnings.join("；");
  };
  const query = dialog.element.querySelector<HTMLTextAreaElement>("[data-query]")!;
  const lookupButton = button("检索 / 解析");
  dialog.element.querySelector("[data-lookup-action]")!.append(lookupButton);
  const importButton = button("导入并创建", true);
  const cancel = button("取消");
  let bytes: Uint8Array | null = null;
  let candidates: MetadataCandidate[] = [];
  let extractionRequest = 0;
  importButton.disabled = true;

  const updatePreview = () => {
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!selected) return;
    const c = selected.canonical;
    dialog.element.querySelectorAll<HTMLTextAreaElement>("[data-edit]").forEach(input => {
      const key = input.dataset.edit!;
      input.value = key === "authors" ? c.creators.map(a => [a.family, a.given].filter(Boolean).join(", ")).join("\n") : String(c[key as keyof typeof c] ?? "");
    });
    preview.innerHTML = candidatePreviewHtml(selected);
  };

  candidateSelect.addEventListener("change", updatePreview);
  const extract = async (manual = false) => {
    const settings = getSettings();
    const shouldExtract = manual || settings.autoExtractMetadata;
    extractionController?.abort();
    const controller = new AbortController();
    extractionController = controller;
    const request = ++extractionRequest;
    setWarnings([]);
    const file = fileInput.files?.[0];
    lookupButton.disabled = true;
    extractButton.disabled = true;
    bytes = null;
    candidates = [];
    importButton.disabled = true;
    candidateSelect.disabled = true;
    if (!file) { lookupButton.disabled = false; preview.textContent = "尚未选择 PDF。"; return; }
    preview.textContent = shouldExtract ? "正在提取元数据…" : "使用文件名创建元数据页。";
    try {
      const selectedBytes = new Uint8Array(await file.arrayBuffer());
      if (request !== extractionRequest || controller.signal.aborted) return;
      bytes = selectedBytes;
      const extractor = new MetadataExtractor({ enableZoteroRecognizer: settings.enableZoteroRecognizer, enableCnki: settings.enableCnki, cnkiRegion: settings.cnkiRegion, cnkiTimeoutSeconds: settings.cnkiTimeoutSeconds, signal: controller.signal });
      const result = shouldExtract
        ? await extractor.extract(selectedBytes, file.name)
        : filenameOnlyResult(file.name);
      if (request !== extractionRequest || controller.signal.aborted) return;
      candidates = result.candidates.includes(result.selected)
        ? result.candidates : [result.selected, ...result.candidates];
      candidateSelect.innerHTML = candidates.map((candidate, index) =>
        `<option value="${index}">${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.canonical.title)} · ${candidate.confidence.toFixed(2)}</option>`).join("");
      candidateSelect.disabled = candidates.length <= 1;
      candidateSelect.value = String(Math.max(0, candidates.indexOf(result.selected)));
      updatePreview();
      setWarnings(result.warnings);
    } catch (error) {
      if (request !== extractionRequest || controller.signal.aborted) return;
      const title = file.name.replace(/\.pdf$/i, "") || "未命名文献";
      candidates = [{
        provider: "filename",
        confidence: 0.2,
        reason: `提取失败：${error instanceof Error ? error.message : String(error)}`,
        canonical: { itemType: "journalArticle", title, creators: [], tags: [] },
      }];
      candidateSelect.innerHTML = `<option value="0">文件名兜底 · ${escapeHtml(title)}</option>`;
      updatePreview();
    } finally {
      if (request === extractionRequest) { extractButton.disabled = !fileInput.files?.length; lookupButton.disabled = false; importButton.disabled = !bytes || !candidates.length; }
    }
  };
  fileInput.addEventListener("change", () => { void extract(); });
  extractButton.addEventListener("click", () => { void extract(true); });

  lookupButton.addEventListener("click", async () => {
    if (!query.value.trim()) { showMessage("请输入标识符、网址或 BibTeX"); return; }
    extractionController?.abort();
    const controller = new AbortController();
    extractionController = controller;
    const request = ++extractionRequest;
    setWarnings([]);
    importButton.disabled = true;
    lookupButton.disabled = extractButton.disabled = true;
    preview.textContent = "正在检索…";
    try {
      const result = await new MetadataExtractor({ signal: controller.signal }).lookup(query.value);
      if (request !== extractionRequest || controller.signal.aborted) return;
      candidates = [...result.candidates, ...candidates];
      candidateSelect.innerHTML = candidates.map((candidate, index) => `<option value="${index}">${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.canonical.title)}</option>`).join("");
      candidateSelect.value = "0";
      candidateSelect.disabled = candidates.length <= 1;
      updatePreview();
      setWarnings(result.warnings);
    } catch (error) {
      if (request !== extractionRequest || controller.signal.aborted) return;
      updatePreview();
      setWarnings([`检索未完成：${error instanceof Error ? error.message : String(error)}。${candidates.length ? "已有候选仍可使用。" : "请重试。"}`]);
    } finally {
      if (request === extractionRequest) {
        importButton.disabled = !candidates.length;
        lookupButton.disabled = false;
        extractButton.disabled = !fileInput.files?.length;
      }
    }
  });

  cancel.addEventListener("click", () => { extractionRequest += 1; dialog.destroy(); });
  importButton.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!selected || (file && !bytes)) {
      showMessage("请先选择 PDF 并等待元数据提取完成", 4000, "error");
      return;
    }
    const edited = { ...selected.canonical };
    dialog.element.querySelectorAll<HTMLTextAreaElement>("[data-edit]").forEach(input => {
      const key = input.dataset.edit!;
      if (key === "authors") edited.creators = input.value.split("\n").map(name => name.trim()).filter(Boolean).map(name => {
        const [family, ...given] = name.split(",");
        return { family: family!.trim(), given: given.join(",").trim(), creatorType: "author" };
      });
      else Object.assign(edited, { [key]: input.value.trim() || undefined });
    });
    if (!edited.title) { showMessage("标题不能为空", 4000, "error"); return; }
    importButton.disabled = true;
    importButton.textContent = "正在导入…";
    fileInput.disabled = extractButton.disabled = lookupButton.disabled = query.disabled = true;
    try {
      const result = await processor.process({
        id: `pdf-${Date.now()}`,
        source: file ? SOURCE.pdf : SOURCE.manual,
        canonical: edited,
        raw: selected.raw ?? { provider: selected.provider, filename: file?.name },
        attachments: file && bytes ? [{ title: file.name, mimeType: "application/pdf", bytes }] : [],
      });
      if (result.action !== "cancelled") showMessage(`PDF 导入完成：${result.title}`, 5000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`PDF 导入失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
      importButton.disabled = false;
      importButton.textContent = "导入并创建";
      fileInput.disabled = extractButton.disabled = lookupButton.disabled = query.disabled = false;
    }
  });
  dialog.element.querySelector<HTMLElement>("[data-actions]")!.append(cancel, importButton);
}

function filenameOnlyResult(filename: string) {
  const title = filename.replace(/\.pdf$/i, "").replace(/_/g, " ").trim() || "未命名文献";
  const candidate: MetadataCandidate = {
    provider: "filename",
    confidence: 0.25,
    reason: "已关闭自动提取，使用文件名",
    canonical: { itemType: "journalArticle", title, creators: [], tags: [] },
  };
  return { selected: candidate, candidates: [candidate], warnings: [] as string[] };
}
