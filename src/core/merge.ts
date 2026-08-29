import type {
  CanonicalField,
  DuplicateConflict,
  PaperCanonical,
  PaperData,
} from "../types/paper";
import { cleanCanonical } from "./normalize";

const FIELDS: CanonicalField[] = [
  "itemType", "title", "creators", "date", "abstract", "doi", "isbn", "issn", "url",
  "journal", "volume", "issue", "pages", "publisher", "language", "tags",
  "collectionTitle", "publisherPlace", "edition", "eventTitle", "number",
];

export function findCanonicalConflicts(existing: PaperCanonical, incoming: PaperCanonical): DuplicateConflict[] {
  return FIELDS.flatMap((field) => {
    const left = existing[field];
    const right = incoming[field];
    return isEmpty(left) || isEmpty(right) || equivalent(left, right)
      ? []
      : [{ field, existing: left, incoming: right }];
  });
}

export function mergePaperData(
  existing: PaperData,
  incoming: PaperData,
  overwrite: CanonicalField[],
): PaperData {
  const overwriteSet = new Set(overwrite);
  const canonical = { ...existing.canonical } as PaperCanonical;
  for (const field of FIELDS) {
    const previous = existing.canonical[field];
    const next = incoming.canonical[field];
    if (overwriteSet.has(field) || (isEmpty(previous) && !isEmpty(next))) {
      assignCanonical(canonical, field, next);
    }
  }
  const attachmentKeys = new Set(existing.attachments.map(attachmentKey));
  const attachments = [...existing.attachments];
  for (const attachment of incoming.attachments) {
    const key = attachmentKey(attachment);
    if (!attachmentKeys.has(key)) {
      attachments.push(attachment);
      attachmentKeys.add(key);
    }
  }
  return {
    ...existing,
    canonical: cleanCanonical(canonical),
    sources: [...existing.sources, ...incoming.sources],
    attachments,
    translation: existing.translation,
    libraryId: existing.libraryId,
    legacyProjectIds: existing.legacyProjectIds,
    updatedAt: new Date().toISOString(),
  };
}

function assignCanonical(target: PaperCanonical, field: CanonicalField, value: unknown): void {
  if (field === "creators") target.creators = Array.isArray(value) ? value as PaperCanonical["creators"] : [];
  else if (field === "tags") target.tags = Array.isArray(value) ? value as string[] : [];
  else (target as unknown as Record<string, unknown>)[field] = value;
}

function attachmentKey(attachment: { sha256: string; assetAddress: string }): string {
  return attachment.sha256 || attachment.assetAddress;
}

function isEmpty(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
