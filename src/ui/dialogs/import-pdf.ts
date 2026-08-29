import { Dialog, showMessage } from "siyuan";
import { SOURCE } from "../../constants";
import type { KernelClient } from "../../core/kernel";
import type { ItemProcessor } from "../../services/item-processor";
import { MetadataExtractor } from "../../services/metadata-extractor";
import type { MetadataCandidate } from "../../types/import";
import type { PluginSettings } from "../../types/settings";
import { button, escapeHtml } from "../dom";

export async function openImportPdfDialog(
  kernel: KernelClient,
  processor: ItemProcessor,
  getSettings: () => PluginSettings,
): Promise<void> {
  const settings = getSettings();
  void kernel;
  const dialog = new Dialog({
    title: "导入本地 PDF",
    width: "720px",
    content: `<div class="b3-dialog__content paper-manager-form">
      <label class="paper-manager-field"><span>PDF 文件</span><input type="file" accept="application/pdf" data-file></label>
      <label class="paper-manager-field"><span>自动提取元数据</span><input type="checkbox" data-extract checked></label>
      <div class="paper-manager-preview">将导入当前默认论文文献库。</div>
      <label class="paper-manager-field"><span>识别候选</span><select class="b3-select" data-candidates disabled><option>选择 PDF 后开始识别</option></select></label>
      <div class="paper-manager-preview" data-preview>尚未选择 PDF。</div>
      <div class="paper-manager-actions" data-actions></div>
    </div>`,
  });
  const fileInput = dialog.element.querySelector<HTMLInputElement>("[data-file]")!;
  const extractToggle = dialog.element.querySelector<HTMLInputElement>("[data-extract]")!;
  const candidateSelect = dialog.element.querySelector<HTMLSelectElement>("[data-candidates]")!;
  const preview = dialog.element.querySelector<HTMLElement>("[data-preview]")!;
  const importButton = button("导入并创建", true);
  const cancel = button("取消");
  let bytes: Uint8Array | null = null;
  let candidates: MetadataCandidate[] = [];

  const updatePreview = () => {
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!selected) return;
    const c = selected.canonical;
    preview.textContent = [
      `来源：${selected.provider} · 置信度 ${selected.confidence.toFixed(2)}`,
      `标题：${c.title}`,
      `作者：${c.creators.map((creator) => `${creator.family}${creator.given ? `, ${creator.given}` : ""}`).join("；") || "未识别"}`,
      `期刊：${c.journal || "未识别"}`,
      `日期：${c.date || "未识别"}`,
      `DOI：${c.doi || "未识别"}`,
      selected.reason,
    ].join("\n");
  };

  candidateSelect.addEventListener("change", updatePreview);
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    bytes = new Uint8Array(await file.arrayBuffer());
    preview.textContent = extractToggle.checked ? "正在提取元数据…" : "使用文件名创建元数据页。";
    importButton.disabled = true;
    try {
      const extractor = new MetadataExtractor({ enableCnki: settings.enableCnki });
      const result = extractToggle.checked
        ? await extractor.extract(bytes, file.name)
        : filenameOnlyResult(file.name);
      candidates = result.candidates.length ? result.candidates : [result.selected];
      candidateSelect.innerHTML = candidates.map((candidate, index) =>
        `<option value="${index}">${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.canonical.title)} · ${candidate.confidence.toFixed(2)}</option>`).join("");
      candidateSelect.disabled = candidates.length <= 1;
      candidateSelect.value = String(Math.max(0, candidates.indexOf(result.selected)));
      updatePreview();
      if (result.warnings.length) preview.textContent += `\n\n提示：${result.warnings.join("；")}`;
    } catch (error) {
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
      importButton.disabled = false;
    }
  });

  cancel.addEventListener("click", () => dialog.destroy());
  importButton.addEventListener("click", async () => {
    const file = fileInput.files?.[0];
    const selected = candidates[Number(candidateSelect.value)] ?? candidates[0];
    if (!file || !bytes || !selected) {
      showMessage("请先选择 PDF 并等待元数据提取完成", 4000, "error");
      return;
    }
    importButton.disabled = true;
    importButton.textContent = "正在导入…";
    try {
      const result = await processor.process({
        id: `pdf-${Date.now()}`,
        source: SOURCE.pdf,
        canonical: selected.canonical,
        raw: selected.raw ?? { provider: selected.provider, filename: file.name },
        attachments: [{ title: file.name, mimeType: "application/pdf", bytes }],
      });
      showMessage(`PDF 导入完成：${result.title}`, 5000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`PDF 导入失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
      importButton.disabled = false;
      importButton.textContent = "导入并创建";
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
