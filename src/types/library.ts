export type LibraryMetadataField =
  | "title"
  | "authors"
  | "year"
  | "journal"
  | "itemType"
  | "doi"
  | "citekey"
  | "tags"
  | "abstract"
  | "publisher"
  | "publisherPlace"
  | "volume"
  | "issue"
  | "pages"
  | "language"
  | "isbn"
  | "issn"
  | "url";

export interface LibraryProject {
  id: string;
  name: string;
  docId?: string;
}

export type LibraryDatabaseField = "addedAt" | "readingStatus" | "rating";

/**
 * 文献库数据 v3：所有元数据列默认创建，列的显示与排序完全由
 * 思源数据库视图管理，插件不再记录 selectedFields / columnOrder。
 */
export interface PaperLibraryDataV3 {
  schemaVersion: 3;
  avId: string;
  avBlockId: string;
  fieldKeyIds: Partial<Record<LibraryMetadataField, string>>;
  projectKeyId: string;
  databaseKeyIds: Partial<Record<LibraryDatabaseField, string>>;
  projects: LibraryProject[];
  createdAt: string;
  updatedAt: string;
}

export type PaperLibraryData = PaperLibraryDataV3;

export const LIBRARY_METADATA_FIELDS: LibraryMetadataField[] = [
  "title", "authors", "year", "journal", "itemType", "doi", "citekey", "tags",
  "abstract", "publisher", "publisherPlace", "volume", "issue", "pages",
  "language", "isbn", "issn", "url",
];

export const LIBRARY_FIELD_LABELS: Record<LibraryMetadataField, string> = {
  title: "标题",
  authors: "作者",
  year: "年份",
  journal: "来源",
  itemType: "类型",
  doi: "DOI",
  citekey: "引用键",
  tags: "标签",
  abstract: "摘要",
  publisher: "出版社",
  publisherPlace: "出版地",
  volume: "卷",
  issue: "期",
  pages: "页码",
  language: "语言",
  isbn: "ISBN",
  issn: "ISSN",
  url: "链接",
};

export const LIBRARY_DATABASE_FIELD_LABELS: Record<LibraryDatabaseField, string> = {
  addedAt: "添加时间",
  readingStatus: "阅读状态",
  rating: "论文打分",
};

export const READING_STATUSES = ["未读", "阅读中", "粗读", "细读"] as const;
