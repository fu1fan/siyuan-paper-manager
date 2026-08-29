import { ATTR } from "../constants";
import type { ImportAttachment, ImportCandidate } from "../types/import";
import type {
  DuplicateMatch,
  DuplicateResolution,
  PaperAttachment,
  PaperData,
} from "../types/paper";
import type { PluginSettings } from "../types/settings";
import { paperStateAttrs } from "../core/codec";
import { readFileBytes, sha256, unlinkIfExists } from "../core/env";
import { KernelClient } from "../core/kernel";
import { findCanonicalConflicts, mergePaperData } from "../core/merge";
import { paperDataFromCandidate } from "../core/normalize";
import {
  normalizeTitle,
  paperDocumentTitle,
  sanitizeDocumentName,
  titleSimilarity,
} from "../core/naming";
import { TemplateService } from "../core/templates";
import { LibraryService, type PaperLibraryInfo } from "./library-service";
import { uniqueCitekey } from "../core/naming";

export interface ProcessResult {
  action: "created" | "merged" | "copied" | "cancelled";
  docId?: string;
  title: string;
}

export type DuplicateResolver = (match: DuplicateMatch, incoming: PaperData) => Promise<DuplicateResolution>;

export class ItemProcessor {
  constructor(
    private readonly kernel: KernelClient,
    private readonly templates: TemplateService,
    private readonly getSettings: () => PluginSettings,
    private readonly resolveDuplicate: DuplicateResolver,
    private readonly libraries: LibraryService,
  ) {}

  async process(
    candidate: ImportCandidate,
  ): Promise<ProcessResult> {
    const settings = this.getSettings();
    if (!settings.defaultLibraryDocId) throw new Error("请先完成初始化并设置默认论文文献库");
    const library = await this.libraries.getLibrary(settings.defaultLibraryDocId);
    const incoming = paperDataFromCandidate(candidate);
    incoming.libraryId = library.docId;
    incoming.citekey = uniqueCitekey(incoming.citekey, await this.libraries.citekeys(library.docId));
    const match = await this.findDuplicate(incoming, library);
    let resolution: DuplicateResolution | null = null;
    if (match) {
      resolution = await this.resolveDuplicate(match, incoming);
      if (resolution.action === "cancel") {
        this.cleanupCandidate(candidate);
        return { action: "cancelled", docId: match.docId, title: incoming.canonical.title };
      }
    }

    try {
      incoming.attachments = await this.uploadAttachments(candidate.attachments, settings.assetsDir, incoming.citekey);
      if (match && resolution?.action === "merge") {
        const merged = mergePaperData(match.existing, incoming, resolution.overwrite);
        await this.persistAndRefresh(match.docId, merged, undefined, true);
        return { action: "merged", docId: match.docId, title: merged.canonical.title };
      }
      const copy = match && resolution?.action === "copy";
      const docId = await this.createPaper(incoming, copy ?? false, library);
      return { action: copy ? "copied" : "created", docId, title: incoming.canonical.title };
    } finally {
      this.cleanupCandidate(candidate);
    }
  }

  /** 修复/刷新论文页：以数据库行为权威重建元数据摘要。 */
  async repair(docId: string): Promise<void> {
    const paper = await this.libraries.readPaper(docId);
    const sections = await this.templates.ensureSections(docId, paper);
    await this.persistAndRefresh(docId, paper, sections.meta);
  }

  /**
   * 回写机器状态属性并刷新元数据摘要。writeMetadata 仅导入/合并时为
   * true：此时 paper 来自外部数据源，需要写入数据库列；其余场景数据库
   * 是权威，不得反向覆盖。
   */
  async persistAndRefresh(
    docId: string,
    paper: PaperData,
    knownMetaBlockId?: string,
    writeMetadata = false,
  ): Promise<void> {
    await this.kernel.setBlockAttrs(docId, paperStateAttrs(paper));
    try {
      await this.templates.refreshMeta(docId, paper, knownMetaBlockId);
    } catch (error) {
      await this.kernel.setBlockAttrs(docId, {
        [ATTR.state]: "failed",
        [ATTR.error]: String(error instanceof Error ? error.message : error).slice(0, 1000),
      });
      throw error;
    }
    try { await this.libraries.syncPaper(docId, paper, writeMetadata); }
    catch (error) { console.warn("[paper-manager] 论文状态已保存，但文献库数据库同步失败", docId, error); }
  }

  private async createPaper(paper: PaperData, copy: boolean, library: PaperLibraryInfo): Promise<string> {
    const title = paperDocumentTitle(paper.canonical, paper.citekey);
    const finalTitle = copy ? `${title} - 副本 ${timestampSuffix()}` : title;
    const markdown = `# ${escapeHeading(finalTitle)}\n`;
    const base = library.hPath.replace(/\/+$/, "");
    const hPath = `${base}/${sanitizeDocumentName(finalTitle)}`;
    const created = await this.kernel.createDocument(library.notebookId, hPath, markdown, finalTitle);
    try {
      await this.kernel.setBlockAttrs(created.id, paperStateAttrs(paper));
      const sections = await this.templates.ensureSections(created.id, paper);
      await this.templates.refreshMeta(created.id, paper, sections.meta);
      try { await this.libraries.syncPaper(created.id, paper, true); }
      catch (error) { console.warn("[paper-manager] 论文页已创建，等待文献库修复同步", created.id, error); }
      return created.id;
    } catch (error) {
      try {
        await this.kernel.setBlockAttrs(created.id, {
          [ATTR.state]: "failed",
          [ATTR.error]: String(error instanceof Error ? error.message : error).slice(0, 1000),
        });
      } catch { /* keep the original failure */ }
      throw new Error(`论文页已创建但初始化失败，可使用“刷新元数据摘要”重试：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 查重直接读当前文献库的数据库行：DOI 列优先，其次引用键 + 标题相似度。 */
  private async findDuplicate(incoming: PaperData, library: PaperLibraryInfo): Promise<DuplicateMatch | null> {
    const candidates = await this.libraries.listPapers(library.docId);
    const doi = incoming.canonical.doi;
    if (doi) {
      const match = candidates.find((candidate) => candidate.paper.canonical.doi === doi);
      if (match) return {
        docId: match.docId,
        reason: "doi",
        existing: match.paper,
        conflicts: findCanonicalConflicts(match.paper.canonical, incoming.canonical),
      };
    }
    for (const candidate of candidates) {
      const existing = candidate.paper;
      if (existing.citekey !== incoming.citekey) continue;
      const sameTitle = titleSimilarity(existing.canonical.title, incoming.canonical.title) >= 0.92
        || normalizeTitle(existing.canonical.title) === normalizeTitle(incoming.canonical.title);
      const doiConflict = existing.canonical.doi && incoming.canonical.doi
        && existing.canonical.doi !== incoming.canonical.doi;
      return {
        docId: candidate.docId,
        reason: doiConflict || !sameTitle ? "citekey-conflict" : "citekey-title",
        existing,
        conflicts: findCanonicalConflicts(existing.canonical, incoming.canonical),
      };
    }
    return null;
  }

  private async uploadAttachments(
    attachments: ImportAttachment[],
    assetsDir: string,
    citekey: string,
  ): Promise<PaperAttachment[]> {
    const output: PaperAttachment[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      const bytes = attachment.bytes ?? (attachment.tempPath ? readFileBytes(attachment.tempPath) : null);
      if (!bytes) continue;
      const digest = await sha256(bytes);
      if (output.some((item) => item.sha256 === digest)) continue;
      const name = attachmentFilename(attachment, citekey, index);
      const assetAddress = await this.kernel.uploadAsset(assetsDir, bytes, name, attachment.mimeType);
      output.push({
        title: attachment.title || name,
        mimeType: attachment.mimeType || "application/octet-stream",
        assetAddress,
        sha256: digest,
        sourceUrl: attachment.sourceUrl,
      });
    }
    return output;
  }

  private cleanupCandidate(candidate: ImportCandidate): void {
    for (const attachment of candidate.attachments) {
      if (attachment.tempPath) unlinkIfExists(attachment.tempPath);
    }
  }
}

function attachmentFilename(attachment: ImportAttachment, citekey: string, index: number): string {
  const ext = extension(attachment.title) || extensionForMime(attachment.mimeType);
  const label = attachment.mimeType === "application/pdf" && index === 0 ? "paper" : `attachment-${index + 1}`;
  return sanitizeDocumentName(`${citekey}-${label}${ext}`, 150);
}

function extension(value: string): string {
  return value.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "";
}

function extensionForMime(mime: string): string {
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/html") return ".html";
  return ".bin";
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/#/g, "\\#");
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
