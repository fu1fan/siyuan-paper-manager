import { ATTR, PAPER_SCHEMA_VERSION } from "../constants";
import type { PaperData, PaperDataV1 } from "../types/paper";

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

export function validatePaperData(value: unknown): PaperDataV1 {
  if (!value || typeof value !== "object") throw new Error("数据不是对象");
  const data = value as Partial<PaperDataV1>;
  if (data.schemaVersion !== PAPER_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion: ${String(data.schemaVersion)}`);
  }
  if (!data.canonical || typeof data.canonical.title !== "string") throw new Error("缺少 canonical.title");
  if (!Array.isArray(data.sources) || !Array.isArray(data.attachments)) throw new Error("来源或附件字段无效");
  if (typeof data.citekey !== "string" || !data.citekey) throw new Error("缺少 citekey");
  return data as PaperDataV1;
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
  };
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#61;/g, "=");
}
