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

export interface PaperLibraryDataV1 {
  schemaVersion: 1;
  avId: string;
  avBlockId: string;
  selectedFields: LibraryMetadataField[];
  fieldKeyIds: Partial<Record<LibraryMetadataField, string>>;
  projectKeyId: string;
  projects: LibraryProject[];
  createdAt: string;
  updatedAt: string;
}

export type PaperLibraryData = PaperLibraryDataV1;

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
