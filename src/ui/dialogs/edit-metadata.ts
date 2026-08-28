import { Dialog, showMessage } from "siyuan";
import type { KernelClient } from "../../core/kernel";
import { cleanCanonical } from "../../core/normalize";
import type { ItemProcessor } from "../../services/item-processor";
import type { PaperCreator } from "../../types/paper";
import { button, escapeHtml, inputValue } from "../dom";

export async function openEditMetadataDialog(
  docId: string,
  kernel: KernelClient,
  processor: ItemProcessor,
): Promise<void> {
  const paper = await kernel.getPaperData(docId);
  const c = paper.canonical;
  const dialog = new Dialog({
    title: `编辑论文元数据 · ${paper.citekey}`,
    width: "760px",
    content: `<div class="b3-dialog__content paper-manager-form">
      ${textField("标题", "title", c.title)}
      ${textField("作者", "creators", creatorsText(c.creators), "每行一位：姓, 名")}
      ${textField("期刊/书名", "journal", c.journal)}
      ${textField("日期", "date", c.date)}
      ${textField("DOI", "doi", c.doi)}
      ${textField("ISBN", "isbn", c.isbn)}
      ${textField("ISSN", "issn", c.issn)}
      ${textField("来源 URL", "url", c.url)}
      ${textField("卷", "volume", c.volume)}
      ${textField("期", "issue", c.issue)}
      ${textField("页码", "pages", c.pages)}
      ${textField("出版社", "publisher", c.publisher)}
      ${textareaField("摘要", "abstract", c.abstract)}
      ${textField("标签", "tags", c.tags.join(", "))}
      <div class="paper-manager-field"><span>PDF 附件</span><input class="b3-text-field" readonly value="${escapeHtml(paper.attachments.find((a) => a.mimeType === "application/pdf")?.assetAddress ?? "无")}"></div>
      <div class="paper-manager-actions" data-actions></div>
    </div>`,
  });
  const actions = dialog.element.querySelector<HTMLElement>("[data-actions]")!;
  const cancel = button("取消");
  const save = button("保存并刷新元数据区", true);
  cancel.addEventListener("click", () => dialog.destroy());
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "保存中…";
    try {
      const root = dialog.element;
      const canonical = cleanCanonical({
        ...c,
        title: inputValue(root, "[data-name=title]") || "未命名文献",
        creators: parseCreators(inputValue(root, "[data-name=creators]")),
        journal: inputValue(root, "[data-name=journal]"),
        date: inputValue(root, "[data-name=date]"),
        doi: inputValue(root, "[data-name=doi]"),
        isbn: inputValue(root, "[data-name=isbn]"),
        issn: inputValue(root, "[data-name=issn]"),
        url: inputValue(root, "[data-name=url]"),
        volume: inputValue(root, "[data-name=volume]"),
        issue: inputValue(root, "[data-name=issue]"),
        pages: inputValue(root, "[data-name=pages]"),
        publisher: inputValue(root, "[data-name=publisher]"),
        abstract: inputValue(root, "[data-name=abstract]"),
        tags: inputValue(root, "[data-name=tags]").split(/[,，;；]/).map((tag) => tag.trim()).filter(Boolean),
      });
      await processor.updateCanonical(docId, canonical);
      showMessage("论文元数据已保存，元数据区已刷新", 4000, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`, 6000, "error");
      save.disabled = false;
      save.textContent = "保存并刷新元数据区";
    }
  });
  actions.append(cancel, save);
}

function textField(label: string, name: string, value?: string, hint?: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}${hint ? `<small title="${escapeHtml(hint)}"> ⓘ</small>` : ""}</span><input class="b3-text-field" data-name="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}"></label>`;
}

function textareaField(label: string, name: string, value?: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}</span><textarea class="b3-text-field" rows="7" data-name="${escapeHtml(name)}">${escapeHtml(value ?? "")}</textarea></label>`;
}

function creatorsText(creators: PaperCreator[]): string {
  return creators.map((creator) => [creator.family, creator.given].filter(Boolean).join(", ")).join("\n");
}

function parseCreators(value: string): PaperCreator[] {
  return value.split(/\r?\n|[;；]/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [family = "", ...given] = line.split(/[,，]/).map((part) => part.trim());
    if (given.length) return { family, given: given.join(" "), creatorType: "author" };
    const parts = line.split(/\s+/);
    return { family: parts.at(-1) ?? line, given: parts.slice(0, -1).join(" "), creatorType: "author" };
  });
}
