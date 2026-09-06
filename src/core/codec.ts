import { ATTR, LIBRARY_SCHEMA_VERSION } from "../constants";
import type { PaperLibraryData } from "../types/library";
import type { PaperData } from "../types/paper";

/** 文献库数据以明文 JSON 存入文档属性。 */
export function encodeLibraryData(data: PaperLibraryData): string {
  return JSON.stringify(data);
}

export function decodeLibraryData(encoded: string): PaperLibraryData {
  try {
    const parsed = parseStoredJson(encoded) as Partial<PaperLibraryData> & { schemaVersion?: number };
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

/**
 * 解析属性中的 JSON；普通解析失败时兼容 SQL 返回的 HTML 转义。
 */
export function parseStoredJson(encoded: string): unknown {
  // 普通 JSON 内的 &quot; 等可能就是用户文本，只有解析失败才解码属性转义。
  try { return JSON.parse(encoded.trim()) as unknown; }
  catch { return JSON.parse(htmlUnescape(encoded.trim())) as unknown; }
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&#0?61;|&#x3D;/gi, "=")
    .replace(/&amp;/g, "&");
}
