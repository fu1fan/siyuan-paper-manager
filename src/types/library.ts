export type LibraryMetadataField =
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

/** 数据库内置列（所属项目 + 阅读字段）与可选论文元数据列的统一标识。 */
export type LibraryColumn = "project" | LibraryDatabaseField | LibraryMetadataField;

export interface PaperLibraryDataV2 {
  schemaVersion: 2;
  avId: string;
  avBlockId: string;
  selectedFields: LibraryMetadataField[];
  fieldKeyIds: Partial<Record<LibraryMetadataField, string>>;
  projectKeyId: string;
  databaseKeyIds: Partial<Record<LibraryDatabaseField, string>>;
  columnOrder: LibraryColumn[];
  projects: LibraryProject[];
  createdAt: string;
  updatedAt: string;
}

export type PaperLibraryData = PaperLibraryDataV2;

export const DEFAULT_LIBRARY_FIELDS: LibraryMetadataField[] = [
  "authors", "year", "journal", "itemType", "doi", "citekey", "tags",
];

export const LIBRARY_FIELD_LABELS: Record<LibraryMetadataField, string> = {
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

export const FIXED_COLUMN_LABELS: Record<"project" | LibraryDatabaseField, string> = {
  project: "所属项目",
  ...LIBRARY_DATABASE_FIELD_LABELS,
};

export const FIXED_COLUMN_HINTS: Record<"project" | LibraryDatabaseField, string> = {
  project: "多选，维护论文归属",
  addedAt: "自动记录",
  readingStatus: READING_STATUSES.join(" / "),
  rating: "数字 0～5",
};

const FIXED_COLUMNS: LibraryColumn[] = ["project", "addedAt", "readingStatus", "rating"];

export function isFixedColumn(column: LibraryColumn): column is "project" | LibraryDatabaseField {
  return FIXED_COLUMNS.includes(column);
}

export function columnLabel(column: LibraryColumn): string {
  return isFixedColumn(column) ? FIXED_COLUMN_LABELS[column] : LIBRARY_FIELD_LABELS[column];
}

export function defaultColumnOrder(): LibraryColumn[] {
  return [...FIXED_COLUMNS, ...(Object.keys(LIBRARY_FIELD_LABELS) as LibraryMetadataField[])];
}

/** 清洗存储的列顺序：丢弃未知列、去重，并补上缺失的列。 */
export function normalizeColumnOrder(order: unknown): LibraryColumn[] {
  const valid = new Set<LibraryColumn>(defaultColumnOrder());
  const cleaned = Array.isArray(order)
    ? order.filter((column): column is LibraryColumn => valid.has(column as LibraryColumn))
    : [];
  const result = Array.from(new Set(cleaned));
  for (const column of defaultColumnOrder()) {
    if (!result.includes(column)) result.push(column);
  }
  return result;
}
