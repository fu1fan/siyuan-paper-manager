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

export interface PaperSourceRecord {
  source: PaperSourceKind;
  importedAt: string;
  sourceUrl?: string;
  sessionId?: string;
  raw: Record<string, unknown>;
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

export interface PaperDataV2 {
  schemaVersion: 2;
  canonical: PaperCanonical;
  sources: PaperSourceRecord[];
  attachments: PaperAttachment[];
  translation: PaperTranslation;
  citekey: string;
  libraryId: string;
  projectIds: string[];
  source: PaperSourceKind;
  importedAt: string;
  updatedAt: string;
}

export type PaperData = PaperDataV2;

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
