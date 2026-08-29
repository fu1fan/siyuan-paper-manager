import { Dialog, showMessage } from "siyuan";
import type { KernelClient } from "../../core/kernel";
import { cleanCanonical } from "../../core/normalize";
import type { ItemProcessor } from "../../services/item-processor";
import type { LibraryService } from "../../services/library-service";
import type { PaperCreator } from "../../types/paper";
import { button, escapeHtml, inputValue } from "../dom";

export async function openEditMetadataDialog(
  docId: string,
  kernel: KernelClient,
  processor: ItemProcessor,
  libraries: LibraryService,
): Promise<void> {
  const paper = await kernel.getPaperData(docId);
  const library = await libraries.getLibrary(paper.libraryId);
  const c = paper.canonical;
  const authors = c.creators.filter((creator) => creator.creatorType === "author");
  const editors = c.creators.filter((creator) => creator.creatorType === "editor");
  const dialog = new Dialog({
    title: `编辑论文元数据 · ${paper.citekey}`,
    width: "920px",
    content: `<div class="b3-dialog__content paper-manager-form paper-manager-metadata-editor">
      <section class="paper-manager-form-section"><h3>基本信息</h3>
        ${textField("标题", "title", c.title)}
        ${textField("文献类型", "itemType", c.itemType)}
        ${textField("引用键", "citekey", paper.citekey, "同一文献库内自动保证唯一")}
        ${textareaField("作者", "authors", creatorsText(authors), 4, "每行一位：姓, 名")}
        ${textareaField("编辑", "editors", creatorsText(editors), 3, "每行一位：姓, 名")}
      </section>
      <section class="paper-manager-form-section"><h3>出版信息</h3>
        ${textField("期刊/书名", "journal", c.journal)}
        ${textField("丛书/集合", "collectionTitle", c.collectionTitle)}
        ${textField("日期", "date", c.date)}
        ${textField("卷", "volume", c.volume)}
        ${textField("期", "issue", c.issue)}
        ${textField("页码", "pages", c.pages)}
        ${textField("出版社", "publisher", c.publisher)}
        ${textField("出版地", "publisherPlace", c.publisherPlace)}
        ${textField("版本", "edition", c.edition)}
        ${textField("会议", "eventTitle", c.eventTitle)}
        ${textField("编号", "number", c.number)}
      </section>
      <section class="paper-manager-form-section"><h3>标识与内容</h3>
        ${textField("DOI", "doi", c.doi)}
        ${textField("ISBN", "isbn", c.isbn)}
        ${textField("ISSN", "issn", c.issn)}
        ${textField("来源 URL", "url", c.url)}
        ${textField("语言", "language", c.language)}
        ${textField("标签", "tags", c.tags.join(", "))}
        ${textareaField("摘要", "abstract", c.abstract, 7)}
      </section>
      <section class="paper-manager-form-section"><h3>所属项目</h3>
        <div class="paper-manager-checkboxes" data-project-list>${library.data.projects.length
          ? library.data.projects.map((project) => `<label title="${escapeHtml(project.docId ?? "纯文本项目")}"><input type="checkbox" data-project-id="${escapeHtml(project.id)}" ${paper.projectIds.includes(project.id) ? "checked" : ""}> ${escapeHtml(project.name)}${project.docId ? " 🔗" : ""}</label>`).join("")
          : "<span class=\"paper-manager-preview\">请先在文献库设置中添加项目。</span>"}</div>
        <div class="paper-manager-field"><span>PDF 附件</span><input class="b3-text-field" readonly value="${escapeHtml(paper.attachments.find((a) => a.mimeType === "application/pdf")?.assetAddress ?? "无")}"></div>
      </section>
      <div class="paper-manager-actions" data-actions></div>
    </div>`,
  });
  const actions = dialog.element.querySelector<HTMLElement>("[data-actions]")!;
  const cancel = button("取消");
  const save = button("保存并同步文献库", true);
  cancel.addEventListener("click", () => dialog.destroy());
  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "保存中…";
    try {
      const root = dialog.element;
      const canonical = cleanCanonical({
        ...c,
        title: inputValue(root, "[data-name=title]") || "未命名文献",
        itemType: inputValue(root, "[data-name=itemType]") || "journalArticle",
        creators: [
          ...parseCreators(inputValue(root, "[data-name=authors]"), "author"),
          ...parseCreators(inputValue(root, "[data-name=editors]"), "editor"),
        ],
        journal: inputValue(root, "[data-name=journal]"),
        collectionTitle: inputValue(root, "[data-name=collectionTitle]"),
        date: inputValue(root, "[data-name=date]"),
        volume: inputValue(root, "[data-name=volume]"),
        issue: inputValue(root, "[data-name=issue]"),
        pages: inputValue(root, "[data-name=pages]"),
        publisher: inputValue(root, "[data-name=publisher]"),
        publisherPlace: inputValue(root, "[data-name=publisherPlace]"),
        edition: inputValue(root, "[data-name=edition]"),
        eventTitle: inputValue(root, "[data-name=eventTitle]"),
        number: inputValue(root, "[data-name=number]"),
        doi: inputValue(root, "[data-name=doi]"),
        isbn: inputValue(root, "[data-name=isbn]"),
        issn: inputValue(root, "[data-name=issn]"),
        url: inputValue(root, "[data-name=url]"),
        language: inputValue(root, "[data-name=language]"),
        abstract: inputValue(root, "[data-name=abstract]"),
        tags: inputValue(root, "[data-name=tags]").split(/[,，;；]/).map((tag) => tag.trim()).filter(Boolean),
      });
      const projectIds = Array.from(root.querySelectorAll<HTMLInputElement>("[data-project-id]:checked"), (input) => input.dataset.projectId!);
      await processor.updateCanonical(docId, canonical, undefined, inputValue(root, "[data-name=citekey]"), projectIds);
      const saved = await kernel.getPaperData(docId);
      showMessage(`论文元数据已保存并同步${saved.citekey !== paper.citekey ? `，引用键：${saved.citekey}` : ""}`, 4500, "info");
      dialog.destroy();
    } catch (error) {
      showMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`, 6000, "error");
      save.disabled = false;
      save.textContent = "保存并同步文献库";
    }
  });
  actions.append(cancel, save);
}

function textField(label: string, name: string, value?: string, hint?: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}${hint ? `<small title="${escapeHtml(hint)}"> ⓘ</small>` : ""}</span><input class="b3-text-field" data-name="${escapeHtml(name)}" value="${escapeHtml(value ?? "")}"></label>`;
}

function textareaField(label: string, name: string, value?: string, rows = 7, hint?: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}${hint ? `<small title="${escapeHtml(hint)}"> ⓘ</small>` : ""}</span><textarea class="b3-text-field" rows="${rows}" data-name="${escapeHtml(name)}">${escapeHtml(value ?? "")}</textarea></label>`;
}

function creatorsText(creators: PaperCreator[]): string {
  return creators.map((creator) => [creator.family, creator.given].filter(Boolean).join(", ")).join("\n");
}

function parseCreators(value: string, creatorType: string): PaperCreator[] {
  return value.split(/\r?\n|[;；]/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [family = "", ...given] = line.split(/[,，]/).map((part) => part.trim());
    if (given.length) return { family, given: given.join(" "), creatorType };
    const parts = line.split(/\s+/);
    return { family: parts.at(-1) ?? line, given: parts.slice(0, -1).join(" "), creatorType };
  });
}
