import { ATTR } from "../constants";
import type { ImportAttachment, ImportCandidate } from "../types/import";
import type {
  DuplicateMatch,
  DuplicateResolution,
  PaperAttachment,
  PaperCanonical,
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
  sanitizeDocumentName,
  titleSimilarity,
} from "../core/naming";
import { TemplateService } from "../core/templates";
import { LibraryService, type LibraryPaperRecord, type PaperLibraryInfo } from "./library-service";
import { uniqueCitekey } from "../core/naming";

export interface ProcessResult {
  action: "created" | "merged" | "copied" | "cancelled";
  docId?: string;
  title: string;
}

export type DuplicateResolver = (match: DuplicateMatch, incoming: PaperData) => Promise<DuplicateResolution>;

export class ItemProcessor {
  private importQueue: Promise<unknown> = Promise.resolve();
  /** Serialize membership changes with imports and metadata edits. */
  runMembershipChange<T>(work: () => Promise<T>): Promise<T> {
    const task = this.importQueue.then(work);
    this.importQueue = task.catch(() => undefined);
    return task;
  }
  constructor(
    private readonly kernel: KernelClient,
    private readonly templates: TemplateService,
    private readonly getSettings: () => PluginSettings,
    private readonly resolveDuplicate: DuplicateResolver,
    private readonly libraries: LibraryService,
  ) {}

  process(candidate: ImportCandidate): Promise<ProcessResult> {
    // PDF 与 Connector 共用队列，查重、引用键分配和落库作为一个完整操作。
    const task = this.importQueue.then(() => this.processCandidate(candidate));
    this.importQueue = task.catch(() => undefined);
    return task.finally(() => this.cleanupCandidate(candidate));
  }

  /** Late Connector files use the existing document and the same import queue. */
  addAttachments(docId: string, attachments: ImportAttachment[]): Promise<void> {
    const task = this.importQueue.then(async () => {
      const before = await this.libraries.readPaper(docId);
      const added = await this.uploadAttachments(attachments, this.getSettings().assetsDir, before.citekey, before.attachments);
      if (!added.length) return;
      // Metadata/translation may have changed while the upload was in progress.
      const latest = await this.libraries.readPaper(docId);
      latest.attachments = [...latest.attachments, ...added.filter((attachment) => !latest.attachments.some((old) => old.sha256 === attachment.sha256))];
      await this.persistAndRefresh(docId, latest);
    });
    this.importQueue = task.catch(() => undefined);
    return task.finally(() => {
      for (const attachment of attachments) if (attachment.tempPath) unlinkIfExists(attachment.tempPath);
    });
  }

  private async processCandidate(candidate: ImportCandidate): Promise<ProcessResult> {
    const settings = this.getSettings();
    if (!settings.defaultLibraryDocId) throw new Error("请先完成初始化并设置默认论文文献库");
    const library = await this.libraries.getLibrary(settings.defaultLibraryDocId);
    const incoming = paperDataFromCandidate(candidate, settings.citekeyFormat);
    incoming.libraryId = library.docId;
    // 一次读取同时取引用键与论文记录，先查重再为新论文分配唯一引用键。
    const { papers, citekeys } = await this.libraries.listPapersAndCitekeys(library.docId);
    const match = this.findDuplicate(incoming, papers);
    let resolution: DuplicateResolution | null = null;
    if (match) {
      resolution = await this.resolveDuplicate(match, incoming);
      if (resolution.action === "cancel") {
        return { action: "cancelled", docId: match.docId, title: incoming.canonical.title };
      }
    }

    if (match && resolution?.action === "merge") {
      // 列表记录仅含数据库元数据；合并前补齐文档属性，避免丢失旧附件和译文。
      const existing = await this.libraries.readPaper(match.docId);
      incoming.attachments = await this.uploadAttachments(
        candidate.attachments, settings.assetsDir, existing.citekey, existing.attachments,
      );
      const merged = mergePaperData(existing, incoming, resolution.overwrite);
      await this.persistAndRefresh(match.docId, merged, undefined, true);
      return { action: "merged", docId: match.docId, title: merged.canonical.title };
    }
    incoming.citekey = uniqueCitekey(incoming.citekey, citekeys);
    incoming.attachments = await this.uploadAttachments(candidate.attachments, settings.assetsDir, incoming.citekey);
    const copy = match && resolution?.action === "copy";
    const docId = await this.createPaper(incoming, copy ?? false, library);
    return { action: copy ? "copied" : "created", docId, title: incoming.canonical.title };
  }

  /** Save only edited fields against a fresh database snapshot. */
  editMetadata(docId: string, baseline: PaperCanonical, draft: PaperCanonical,
    citekeyEdit?: { baseline: string; value: string }): Promise<void> {
    const task = this.importQueue.then(async () => {
      if (!draft.title.trim()) throw new Error("标题不能为空");
      const latest = await this.libraries.readPaper(docId);
      const changeKey = citekeyEdit && citekeyEdit.value !== citekeyEdit.baseline;
      if (changeKey) {
        const key = citekeyEdit.value;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(key)) {
          throw new Error("引用键须为 1–120 位英文字母、数字、下划线或连字符，并以字母或数字开头");
        }
        if (latest.citekey !== citekeyEdit.baseline && latest.citekey !== key) {
          throw new Error("引用键已在数据库中更改，请重新打开编辑页后再保存");
        }
        const used = await this.libraries.citekeys(latest.libraryId, docId);
        if (used.some(value => value.toLowerCase() === key.toLowerCase())) {
          throw new Error("该引用键已被同库其他条目使用，请修改或重新生成");
        }
      }
      for (const key of new Set([...Object.keys(baseline), ...Object.keys(draft)]) as Set<keyof PaperCanonical>) {
        if (JSON.stringify(baseline[key]) === JSON.stringify(draft[key])) continue;
        if (JSON.stringify(latest.canonical[key]) !== JSON.stringify(baseline[key])
          && JSON.stringify(latest.canonical[key]) !== JSON.stringify(draft[key])) {
          throw new Error(`字段 ${key} 已在数据库中更改，请重新打开编辑页后再保存`);
        }
      }
      for (const key of new Set([...Object.keys(baseline), ...Object.keys(draft)]) as Set<keyof PaperCanonical>) {
        if (JSON.stringify(baseline[key]) !== JSON.stringify(draft[key])) Object.assign(latest.canonical, { [key]: draft[key] });
      }
      // Commit the database first: it remains authoritative if summary rendering fails.
      if (changeKey) latest.citekey = citekeyEdit.value;
      await this.syncPaperWithRetry(docId, latest, true);
      // Keep the same document and database row IDs. Repeating save also repairs
      // a rename that failed after the authoritative citekey was committed.
      if (changeKey) await this.kernel.renameDocument(docId, latest.citekey);
      const sections = await this.templates.ensureSections(docId, latest);
      await this.persistAndRefresh(docId, latest, sections.meta);
    });
    this.importQueue = task.catch(() => undefined);
    return task;
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
    await this.syncPaperWithRetry(docId, paper, writeMetadata);
  }

  private async syncPaperWithRetry(docId: string, paper: PaperData, writeMetadata: boolean): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.libraries.syncPaper(docId, paper, writeMetadata);
        return;
      } catch (error) {
        if (attempt >= 2) throw new Error(`论文页 ${docId} 已保存，但数据库同步自动重试后仍失败：${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  private async createPaper(paper: PaperData, copy: boolean, library: PaperLibraryInfo): Promise<string> {
    // 文档命名用单独的 citekey；正文首个 H1 保留论文全文标题（不含 citekey）
    const docName = copy ? `${paper.citekey} 副本 ${timestampSuffix()}` : paper.citekey;
    const markdown = `# ${escapeHeading(paper.canonical.title || "未命名文献")}\n`;
    const base = library.hPath.replace(/\/+$/, "");
    const hPath = `${base}/${sanitizeDocumentName(docName)}`;
    const created = await this.kernel.createDocument(library.notebookId, hPath, markdown, docName);
    try {
      await this.kernel.setBlockAttrs(created.id, paperStateAttrs(paper));
      const sections = await this.templates.ensureSections(created.id, paper);
      await this.templates.refreshMeta(created.id, paper, sections.meta);
      await this.syncPaperWithRetry(created.id, paper, true);
      return created.id;
    } catch (error) {
      try {
        await this.kernel.setBlockAttrs(created.id, {
          [ATTR.state]: "failed",
          [ATTR.error]: String(error instanceof Error ? error.message : error).slice(0, 1000),
        });
      } catch { /* keep the original failure */ }
      throw new Error(`论文页已创建但初始化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 查重直接读当前文献库的数据库行：DOI 列优先，其次引用键 + 标题相似度。 */
  private findDuplicate(incoming: PaperData, candidates: LibraryPaperRecord[]): DuplicateMatch | null {
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
    existing: PaperAttachment[] = [],
  ): Promise<PaperAttachment[]> {
    const output: PaperAttachment[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      const bytes = attachment.bytes ?? (attachment.tempPath ? readFileBytes(attachment.tempPath) : null);
      if (!bytes) continue;
      const digest = await sha256(bytes);
      if (existing.some((item) => item.sha256 === digest) || output.some((item) => item.sha256 === digest)) continue;
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
