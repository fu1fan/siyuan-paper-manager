import { ATTR, PAPER_SCHEMA_VERSION } from "../constants";
import type { PaperData, PaperDataV2 } from "../types/paper";
import type { PaperLibraryData } from "../types/library";
import { LIBRARY_SCHEMA_VERSION } from "../constants";

export function encodePaperData(data: PaperData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function decodePaperData(encoded: string): PaperData {
  try {
    const binary = atob(htmlDecode(encoded.trim()));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return validatePaperData(parsed);
  } catch (error) {
    throw new Error(`论文元数据损坏: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validatePaperData(value: unknown): PaperDataV2 {
  if (!value || typeof value !== "object") throw new Error("数据不是对象");
  const data = value as Partial<PaperDataV2>;
  if (data.schemaVersion !== PAPER_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion: ${String(data.schemaVersion)}`);
  }
  if (!data.canonical || typeof data.canonical.title !== "string") throw new Error("缺少 canonical.title");
  if (!Array.isArray(data.sources) || !Array.isArray(data.attachments)) throw new Error("来源或附件字段无效");
  if (typeof data.citekey !== "string" || !data.citekey) throw new Error("缺少 citekey");
  if (typeof data.libraryId !== "string") throw new Error("缺少 libraryId");
  if (!Array.isArray(data.projectIds)) throw new Error("projectIds 无效");
  return data as PaperDataV2;
}

export function encodeLibraryData(data: PaperLibraryData): string {
  return encodeJson(data);
}

export function decodeLibraryData(encoded: string): PaperLibraryData {
  try {
    const parsed = decodeJson(encoded) as Partial<PaperLibraryData>;
    if (parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION) throw new Error(`不支持的 schemaVersion: ${String(parsed.schemaVersion)}`);
    if (!parsed.avId || !parsed.avBlockId || !parsed.projectKeyId) throw new Error("数据库标识不完整");
    if (!Array.isArray(parsed.selectedFields) || !Array.isArray(parsed.projects)) throw new Error("字段或项目无效");
    return parsed as PaperLibraryData;
  } catch (error) {
    throw new Error(`文献库数据损坏: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function paperIndexAttrs(data: PaperData): Record<string, string> {
  const pdf = data.attachments.find((attachment) => attachment.mimeType === "application/pdf");
  const assets = [
    ...data.attachments.map((attachment) => attachment.assetAddress),
    data.translation.mono,
    data.translation.dual,
  ].filter((value): value is string => Boolean(value));
  return {
    [ATTR.data]: encodePaperData(data),
    [ATTR.citekey]: data.citekey,
    [ATTR.doi]: data.canonical.doi ?? "",
    [ATTR.attachmentPdf]: pdf?.assetAddress ?? "",
    [ATTR.translationMono]: data.translation.mono ?? "",
    [ATTR.translationDual]: data.translation.dual ?? "",
    [ATTR.assets]: JSON.stringify(assets),
    [ATTR.state]: "ready",
    [ATTR.error]: "",
    [ATTR.libraryId]: data.libraryId,
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
