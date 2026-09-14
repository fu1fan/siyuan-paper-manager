import type { PaperAttachment, PaperData } from "../types/paper";
import { safeAssetUrl } from "../core/normalize";

export type AttachmentState = Pick<PaperData, "attachments" | "translation" | "originalPdf">;
export interface PendingAttachment {
  id: string;
  bytes: Uint8Array;
  title: string;
  mimeType: string;
  /** Reuse uploads if persistence fails and the user retries saving. */
  uploaded?: PaperAttachment;
}
export interface AttachmentEdit {
  baseline: AttachmentState;
  draft: AttachmentState;
  additions: PendingAttachment[];
}

export function attachmentState(paper: AttachmentState): AttachmentState {
  return structuredClone({ attachments: paper.attachments, translation: paper.translation, originalPdf: paper.originalPdf });
}

function isPdfAttachment(attachment: PaperAttachment): boolean {
  return attachment.mimeType === "application/pdf" || /\.pdf$/i.test(attachment.assetAddress);
}

export function originalPdfCandidates(paper: AttachmentState): PaperAttachment[] {
  const key = (value: string) => safeAssetUrl(value) ?? value;
  const translated = new Set([paper.translation.mono, paper.translation.dual].filter((value): value is string => Boolean(value)).map(key));
  return paper.attachments.filter(attachment => isPdfAttachment(attachment) && !translated.has(key(attachment.assetAddress)));
}

/** Never silently pick a supplementary PDF or a translated output. */
export function translationSource(paper: AttachmentState): PaperAttachment {
  const candidates = originalPdfCandidates(paper);
  if (paper.originalPdf) {
    const selected = candidates.find(attachment => attachment.assetAddress === paper.originalPdf);
    if (!selected) throw new Error("指定的论文原稿已不存在或不是可用 PDF，请在元数据编辑页重新指定原稿");
    return selected;
  }
  if (!candidates.length) throw new Error("当前论文没有可翻译的 PDF 附件");
  if (candidates.length > 1) throw new Error("当前论文有多个 PDF，请先在元数据编辑页的附件管理中指定论文原稿");
  return candidates[0]!;
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function conflict(label: string): never { throw new Error(`${label}已在其他操作中更改，请重新打开编辑页后再保存`); }

/** Apply only edited attachment fields, preserving late Connector files and new translations. */
export function mergeAttachmentEdit(latest: PaperData, baseline: AttachmentState, draft: AttachmentState): PaperData {
  const result = structuredClone(latest);
  for (const before of baseline.attachments) {
    const after = draft.attachments.find(item => item.assetAddress === before.assetAddress);
    if (after && before.title === after.title) continue;
    const index = result.attachments.findIndex(item => item.assetAddress === before.assetAddress);
    const current = result.attachments[index];
    if (!after) {
      if (current && current.title !== before.title) conflict("附件名称");
      if (index >= 0) result.attachments.splice(index, 1);
    } else {
      if (!current || (current.title !== before.title && current.title !== after.title)) conflict("附件");
      current.title = after.title.trim();
    }
  }
  for (const added of draft.attachments.filter(item => !baseline.attachments.some(old => old.assetAddress === item.assetAddress))) {
    if (!result.attachments.some(item => item.assetAddress === added.assetAddress)) result.attachments.push(structuredClone(added));
  }
  for (const kind of ["mono", "dual"] as const) {
    const titleKey = kind === "mono" ? "monoTitle" : "dualTitle";
    const before = [baseline.translation[kind], baseline.translation[titleKey]];
    const after = [draft.translation[kind], draft.translation[titleKey]];
    if (equal(before, after)) continue;
    const current = [latest.translation[kind], latest.translation[titleKey]];
    if (!equal(current, before) && !equal(current, after)) conflict("翻译附件");
    result.translation[kind] = draft.translation[kind];
    result.translation[titleKey] = draft.translation[kind] ? draft.translation[titleKey]?.trim() || undefined : undefined;
  }
  if (baseline.originalPdf !== draft.originalPdf) {
    if (latest.originalPdf !== baseline.originalPdf && latest.originalPdf !== draft.originalPdf) conflict("论文原稿");
    result.originalPdf = draft.originalPdf;
  }
  if (result.originalPdf && !originalPdfCandidates(result).some(item => item.assetAddress === result.originalPdf)) {
    // Removing the chosen original clears its designation, but must not clear a
    // concurrent designation of a different attachment.
    if (baseline.originalPdf === result.originalPdf && !draft.attachments.some(item => item.assetAddress === result.originalPdf)) result.originalPdf = undefined;
    else conflict("论文原稿");
  }
  for (const item of result.attachments) {
    if (!item.title?.trim()) throw new Error("附件名称不能为空");
    if (!safeAssetUrl(item.assetAddress) && !item.assetAddress.startsWith("pending:")) throw new Error("附件资源路径无效");
  }
  return result;
}
