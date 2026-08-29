import { SOURCE } from "../constants";
import type { ImportCandidate, ZoteroCreator } from "../types/import";
import type { PaperCanonical, PaperCreator, PaperData, PaperSourceKind } from "../types/paper";
import { generateCitekey, normalizeDoi } from "./naming";

export function canonicalFromRaw(raw: Record<string, unknown>): PaperCanonical {
  const creators = Array.isArray(raw.creators)
    ? raw.creators.map((creator) => normalizeCreator(creator as ZoteroCreator)).filter(Boolean) as PaperCreator[]
    : [];
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => typeof tag === "string" ? tag : string((tag as Record<string, unknown>)?.tag)).filter(Boolean)
    : [];
  return cleanCanonical({
    itemType: string(raw.itemType) || "journalArticle",
    title: string(raw.title) || "未命名文献",
    creators,
    date: string(raw.date),
    abstract: string(raw.abstractNote ?? raw.abstract),
    doi: normalizeDoi(raw.DOI ?? raw.doi),
    isbn: string(raw.ISBN ?? raw.isbn),
    issn: string(raw.ISSN ?? raw.issn),
    url: safeExternalUrl(string(raw.url)),
    journal: string(raw.publicationTitle ?? raw.bookTitle ?? raw.journal),
    collectionTitle: string(raw.series ?? raw.collectionTitle),
    volume: string(raw.volume),
    issue: string(raw.issue),
    pages: string(raw.pages),
    publisher: string(raw.publisher),
    publisherPlace: string(raw.place ?? raw.publisherPlace),
    edition: string(raw.edition),
    eventTitle: string(raw.conferenceName ?? raw.eventTitle),
    number: string(raw.number ?? raw.seriesNumber),
    language: string(raw.language),
    tags,
  });
}

export function cleanCanonical(input: PaperCanonical): PaperCanonical {
  return {
    itemType: input.itemType?.trim() || "journalArticle",
    title: sanitizeText(input.title || "未命名文献", 1000),
    creators: (input.creators ?? []).map((creator) => ({
      family: sanitizeText(creator.family, 200),
      given: sanitizeText(creator.given, 200),
      creatorType: sanitizeText(creator.creatorType || "author", 50),
    })),
    date: optionalText(input.date, 100),
    abstract: optionalText(input.abstract, 50_000),
    doi: normalizeDoi(input.doi),
    isbn: optionalText(input.isbn, 100),
    issn: optionalText(input.issn, 100),
    url: safeExternalUrl(input.url),
    journal: optionalText(input.journal, 1000),
    collectionTitle: optionalText(input.collectionTitle, 1000),
    volume: optionalText(input.volume, 100),
    issue: optionalText(input.issue, 100),
    pages: optionalText(input.pages, 100),
    publisher: optionalText(input.publisher, 1000),
    publisherPlace: optionalText(input.publisherPlace, 1000),
    edition: optionalText(input.edition, 100),
    eventTitle: optionalText(input.eventTitle, 1000),
    number: optionalText(input.number, 100),
    language: optionalText(input.language, 100),
    tags: Array.from(new Set((input.tags ?? []).map((tag) => sanitizeText(tag, 200)).filter(Boolean))),
  };
}

export function paperDataFromCandidate(candidate: ImportCandidate): PaperData {
  const now = new Date().toISOString();
  const canonical = cleanCanonical(candidate.canonical);
  return {
    schemaVersion: 2,
    canonical,
    sources: [{
      source: candidate.source,
      importedAt: now,
      sourceUrl: safeExternalUrl(candidate.sourceUrl),
      sessionId: optionalText(candidate.sessionId, 200),
      raw: structuredCloneSafe(candidate.raw),
    }],
    attachments: [],
    translation: {},
    citekey: generateCitekey(canonical),
    libraryId: "",
    projectIds: [],
    source: candidate.source,
    importedAt: now,
    updatedAt: now,
  };
}

export function manualSource(raw: Record<string, unknown>): { source: PaperSourceKind; importedAt: string; raw: Record<string, unknown> } {
  return { source: SOURCE.manual, importedAt: new Date().toISOString(), raw: structuredCloneSafe(raw) };
}

export function safeAssetUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean.startsWith("assets/") || clean.includes("..")) return undefined;
  return clean;
}

export function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCreator(value: ZoteroCreator): PaperCreator | null {
  const full = string(value.name);
  const family = string(value.lastName ?? value.family) || (full ? full.split(/\s+/).at(-1) ?? full : "");
  const given = string(value.firstName ?? value.given) || (full ? full.split(/\s+/).slice(0, -1).join(" ") : "");
  if (!family && !given) return null;
  return { family, given, creatorType: string(value.creatorType) || "author" };
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function optionalText(value: unknown, max: number): string | undefined {
  const clean = sanitizeText(string(value), max);
  return clean || undefined;
}

function sanitizeText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
}
