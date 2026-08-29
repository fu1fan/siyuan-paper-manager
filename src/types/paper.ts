export type PaperSourceKind = "zotero-connector" | "pdf-import" | "manual";

export interface PaperCreator {
  family: string;
  given: string;
  creatorType: string;
}

export interface PaperCanonical {
  itemType: string;
  title: string;
  creators: PaperCreator[];
  date?: string;
  abstract?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  journal?: string;
  collectionTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publisherPlace?: string;
  edition?: string;
  eventTitle?: string;
  number?: string;
  language?: string;
  tags: string[];
}

export interface PaperAttachment {
  title: string;
  mimeType: string;
  assetAddress: string;
  sha256: string;
  sourceUrl?: string;
}

export interface PaperTranslation {
  mono?: string;
  dual?: string;
  executable?: string;
  args?: string[];
  completedAt?: string;
}

/**
 * 论文的运行时表示：元数据以文献库数据库行为权威，此处仅用于导入、
 * 合并、摘要渲染等流程内的组装。附件与翻译产物等机器状态存于文档
 * 自定义属性。
 */
export interface PaperData {
  canonical: PaperCanonical;
  citekey: string;
  libraryId: string;
  attachments: PaperAttachment[];
  translation: PaperTranslation;
}

export type CanonicalField = Exclude<keyof PaperCanonical, "creators" | "tags"> | "creators" | "tags";

export interface DuplicateConflict {
  field: CanonicalField;
  existing: unknown;
  incoming: unknown;
}

export type DuplicateResolution =
  | { action: "cancel" }
  | { action: "copy" }
  | { action: "merge"; overwrite: CanonicalField[] };

export interface DuplicateMatch {
  docId: string;
  reason: "doi" | "citekey-title" | "citekey-conflict";
  existing: PaperData;
  conflicts: DuplicateConflict[];
}
