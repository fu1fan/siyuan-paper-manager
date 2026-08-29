import { ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import type { PaperLibraryData } from "../types/library";
import type { PaperAttachment, PaperCanonical, PaperData, PaperTranslation } from "../types/paper";

export function encodeLibraryData(data: PaperLibraryData): string {
  return encodeJson(data);
}

export function decodeLibraryData(encoded: string): PaperLibraryData {
  try {
    const parsed = decodeJson(encoded) as Partial<PaperLibraryData> & { schemaVersion?: number };
    if (![1, 2, LIBRARY_SCHEMA_VERSION].includes(parsed.schemaVersion ?? 0)) {
      throw new Error(`不支持的 schemaVersion: ${String(parsed.schemaVersion)}`);
    }
    if (!parsed.avId || !parsed.avBlockId || !parsed.projectKeyId) throw new Error("数据库标识不完整");
    if (!Array.isArray(parsed.projects)) throw new Error("项目定义无效");
    // v1/v2 的 selectedFields 与 columnOrder 随数据库权威化移除：列全部创建，
    // 显示与排序交给思源数据库视图。
    return {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      avId: parsed.avId,
      avBlockId: parsed.avBlockId,
      fieldKeyIds: parsed.fieldKeyIds ?? {},
      projectKeyId: parsed.projectKeyId,
      databaseKeyIds: parsed.databaseKeyIds ?? {},
      projects: parsed.projects,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    throw new Error(`文献库数据损坏: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 旧版 base64 论文数据的宽松解码结果，仅用于一次性迁移。 */
export interface LegacyPaperData {
  canonical: PaperCanonical;
  citekey: string;
  libraryId: string;
  attachments: PaperAttachment[];
  translation: PaperTranslation;
  projectIds: string[];
}

/**
 * 解码 schema v2/v3 的 base64 论文数据。迁移完成后不再有调用方，
 * 请勿在新代码中使用。
 */
export function decodeLegacyPaperData(encoded: string): LegacyPaperData {
  try {
    const parsed = decodeJson(encoded) as Record<string, unknown>;
    if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
      throw new Error(`不支持的 schemaVersion: ${String(parsed.schemaVersion)}`);
    }
    const canonical = parsed.canonical as PaperCanonical | undefined;
    if (!canonical || typeof canonical.title !== "string") throw new Error("缺少 canonical.title");
    if (!Array.isArray(canonical.creators)) canonical.creators = [];
    if (!Array.isArray(canonical.tags)) canonical.tags = [];
    const projectIds = Array.isArray(parsed.projectIds) ? parsed.projectIds : [];
    return {
      canonical,
      citekey: typeof parsed.citekey === "string" ? parsed.citekey : "",
      libraryId: typeof parsed.libraryId === "string" ? parsed.libraryId : "",
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments as PaperAttachment[] : [],
      translation: (parsed.translation ?? {}) as PaperTranslation,
      projectIds: projectIds.filter((id): id is string => typeof id === "string"),
    };
  } catch (error) {
    throw new Error(`旧版论文元数据损坏: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 论文文档的机器状态属性（非用户元数据）：附件清单、翻译产物与
 * 处理状态。用户可见的元数据一律以文献库数据库行为权威。
 */
export function paperStateAttrs(paper: PaperData): Record<string, string> {
  return {
    [ATTR.attachments]: JSON.stringify(paper.attachments),
    [ATTR.translationMono]: paper.translation.mono ?? "",
    [ATTR.translationDual]: paper.translation.dual ?? "",
    [ATTR.state]: "ready",
    [ATTR.error]: "",
    [ATTR.libraryId]: paper.libraryId,
  };
}

function encodeJson(data: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeJson(encoded: string): unknown {
  const binary = atob(htmlDecode(encoded.trim()));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#61;/g, "=");
}
