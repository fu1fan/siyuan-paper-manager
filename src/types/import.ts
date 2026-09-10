import type { PaperCanonical, PaperSourceKind } from "./paper";

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
  [key: string]: unknown;
}

export interface ZoteroAttachmentMetadata {
  id?: string;
  parentItemID?: string;
  parentItem?: string;
  title?: string;
  url?: string;
  contentType?: string;
  mimeType?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface ImportAttachment {
  title: string;
  mimeType: string;
  sourceUrl?: string;
  tempPath?: string;
  bytes?: Uint8Array;
  connectorId?: string;
  parentItemId?: string;
}

export interface ImportCandidate {
  id: string;
  source: PaperSourceKind;
  canonical: PaperCanonical;
  raw: Record<string, unknown>;
  attachments: ImportAttachment[];
  sourceUrl?: string;
  sessionId?: string;
  warnings?: string[];
}

export interface MetadataCandidate {
  canonical: PaperCanonical;
  provider: "zotero" | "arxiv" | "bibtex" | "pdf-text" | "xmp" | "crossref" | "citoid" | "cnki" | "filename";
  confidence: number;
  reason: string;
  raw?: Record<string, unknown>;
}

export interface ExtractionResult {
  selected: MetadataCandidate;
  candidates: MetadataCandidate[];
  detectedDoi?: string;
  warnings: string[];
}
