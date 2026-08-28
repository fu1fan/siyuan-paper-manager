import type { ExtractionResult, MetadataCandidate } from "../types/import";
import type { PaperCanonical, PaperCreator } from "../types/paper";
import { cleanCanonical } from "../core/normalize";
import { normalizeDoi, titleSimilarity } from "../core/naming";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

interface PdfMetadataSnapshot {
  info: Record<string, unknown>;
  xmp: Record<string, string>;
  text: string;
}

export interface MetadataExtractorOptions {
  fetchImpl?: typeof fetch;
  enableCnki?: boolean;
  timeoutMs?: number;
}

export class MetadataExtractor {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: MetadataExtractorOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // Keep the browser receiver for Electron/Chromium native fetch. Invoking a
    // raw fetch reference as `this.fetchImpl()` otherwise throws Illegal invocation.
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async extract(bytes: Uint8Array, filename: string): Promise<ExtractionResult> {
    const warnings: string[] = [];
    let snapshot: PdfMetadataSnapshot = { info: {}, xmp: {}, text: "" };
    try {
      snapshot = await inspectPdf(bytes);
    } catch (error) {
      warnings.push(`PDF 本地解析失败：${message(error)}`);
    }
    const detectedDoi = findDoi(snapshot.text)
      ?? normalizeDoi(snapshot.info.DOI ?? snapshot.xmp.doi);
    const local = localCandidate(snapshot, filename, detectedDoi);
    const candidates: MetadataCandidate[] = [local];

    if (detectedDoi) {
      try {
        const crossref = await this.crossrefByDoi(detectedDoi);
        if (crossref) candidates.push(crossref);
      } catch (error) {
        warnings.push(`Crossref 查询失败：${message(error)}`);
      }
      if (!candidates.some((candidate) => candidate.provider === "crossref")) {
        try {
          const citoid = await this.citoidByDoi(detectedDoi);
          if (citoid) candidates.push(citoid);
        } catch (error) {
          warnings.push(`Citoid 查询失败：${message(error)}`);
        }
      }
    } else if (local.canonical.title && local.provider !== "filename") {
      try {
        candidates.push(...await this.crossrefByTitle(local.canonical));
      } catch (error) {
        warnings.push(`Crossref 标题检索失败：${message(error)}`);
      }
    }

    if (this.options.enableCnki && containsCjk(local.canonical.title)) {
      try {
        candidates.push(...await this.cnkiByTitle(local.canonical));
      } catch (error) {
        warnings.push(`中文检索失败：${message(error)}`);
      }
    }

    const deduplicated = dedupeCandidates(candidates).sort((left, right) => right.confidence - left.confidence);
    const best = deduplicated[0] ?? filenameCandidate(filename, detectedDoi);
    const selected = best.confidence >= 0.92 || deduplicated.length === 1
      ? best
      : mergeMetadata(local, best);
    return { selected, candidates: deduplicated, detectedDoi, warnings };
  }

  private async crossrefByDoi(doi: string): Promise<MetadataCandidate | null> {
    const response = await this.fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    const message = isRecord(response) && isRecord(response.message) ? response.message : null;
    return message ? crossrefCandidate(message, 1, "DOI 精确匹配") : null;
  }

  private async crossrefByTitle(local: PaperCanonical): Promise<MetadataCandidate[]> {
    const query = new URLSearchParams({ query: local.title, rows: "5", select: "DOI,title,author,published,container-title,publisher,URL,abstract,volume,issue,page,type,ISBN,ISSN,language" });
    const response = await this.fetchJson(`https://api.crossref.org/works?${query.toString()}`);
    const items = isRecord(response) && isRecord(response.message) && Array.isArray(response.message.items)
      ? response.message.items.filter(isRecord)
      : [];
    return items.map((item) => {
      const candidate = crossrefCandidate(item, 0, "标题检索");
      const score = metadataConfidence(local, candidate.canonical);
      return { ...candidate, confidence: score, reason: `Crossref 标题相似度 ${score.toFixed(2)}` };
    }).filter((candidate) => candidate.confidence >= 0.55);
  }

  private async citoidByDoi(doi: string): Promise<MetadataCandidate | null> {
    const target = encodeURIComponent(`https://doi.org/${doi}`);
    const response = await this.fetchJson(`https://en.wikipedia.org/api/rest_v1/data/citation/zotero/${target}`);
    const raw = Array.isArray(response) ? response.find(isRecord) : isRecord(response) ? response : null;
    if (!raw) return null;
    return {
      canonical: canonicalFromCitoid(raw),
      provider: "citoid",
      confidence: 0.98,
      reason: "Citoid DOI 匹配",
      raw,
    };
  }

  private async cnkiByTitle(local: PaperCanonical): Promise<MetadataCandidate[]> {
    const url = `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(local.title)}`;
    const response = await this.fetchWithRetry(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const html = await response.text();
    return parseCnkiHtml(html).map((candidate) => {
      const confidence = metadataConfidence(local, candidate.canonical);
      return { ...candidate, confidence, reason: `CNKI 标题相似度 ${confidence.toFixed(2)}` };
    }).filter((candidate) => candidate.confidence >= 0.55);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchWithRetry(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "siyuan-paper-manager/0.3.0 (+https://github.com/fu1fan/siyuan-paper-manager)",
      },
    });
    return response.json();
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (response.ok) return response;
        if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
        const retryAfter = Math.min(5_000, Number(response.headers.get("Retry-After") || 0) * 1000);
        await sleep(retryAfter || 300 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(300 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("网络请求失败");
  }
}

async function inspectPdf(bytes: Uint8Array): Promise<PdfMetadataSnapshot> {
  const loading = pdfjs.getDocument({
    data: bytes.slice(),
  });
  const document = await loading.promise;
  try {
    const metadata = await document.getMetadata().catch(() => null);
    const info = metadata?.info && typeof metadata.info === "object"
      ? metadata.info as unknown as Record<string, unknown>
      : {};
    const xmp: Record<string, string> = {};
    const xmpObject = metadata?.metadata as { get?: (key: string) => unknown } | null | undefined;
    for (const key of ["dc:title", "dc:creator", "dc:description", "dc:subject", "prism:doi"]) {
      const value = xmpObject?.get?.(key);
      if (typeof value === "string") xmp[key === "prism:doi" ? "doi" : key] = value;
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(3, document.numPages); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      page.cleanup();
    }
    return { info, xmp, text: pages.join("\n") };
  } finally {
    await loading.destroy();
  }
}

function localCandidate(snapshot: PdfMetadataSnapshot, filename: string, doi?: string): MetadataCandidate {
  const title = firstString(snapshot.xmp["dc:title"], snapshot.info.Title) || filenameTitle(filename);
  const author = firstString(snapshot.xmp["dc:creator"], snapshot.info.Author);
  const creators = author ? splitAuthors(author) : [];
  const canonical = cleanCanonical({
    itemType: "journalArticle",
    title,
    creators,
    date: firstString(snapshot.info.CreationDate),
    abstract: firstString(snapshot.xmp["dc:description"], snapshot.info.Subject),
    doi,
    tags: splitTags(firstString(snapshot.xmp["dc:subject"], snapshot.info.Keywords)),
  });
  const hasEmbedded = title !== filenameTitle(filename) || creators.length > 0;
  return {
    canonical,
    provider: hasEmbedded ? "xmp" : "filename",
    confidence: doi ? 0.72 : hasEmbedded ? 0.58 : 0.3,
    reason: hasEmbedded ? "PDF 内嵌元数据" : "文件名兜底",
    raw: { info: snapshot.info, xmp: snapshot.xmp },
  };
}

function filenameCandidate(filename: string, doi?: string): MetadataCandidate {
  return {
    canonical: cleanCanonical({ itemType: "journalArticle", title: filenameTitle(filename), creators: [], doi, tags: [] }),
    provider: "filename",
    confidence: doi ? 0.5 : 0.25,
    reason: "文件名兜底",
  };
}

function crossrefCandidate(raw: Record<string, unknown>, confidence: number, reason: string): MetadataCandidate {
  const authors = Array.isArray(raw.author) ? raw.author.filter(isRecord).map((author): PaperCreator => ({
    family: string(author.family),
    given: string(author.given),
    creatorType: "author",
  })) : [];
  const dateParts = datePartsFromCrossref(raw);
  return {
    canonical: cleanCanonical({
      itemType: crossrefType(string(raw.type)),
      title: firstArrayString(raw.title) || "未命名文献",
      creators: authors,
      date: dateParts,
      abstract: stripTags(string(raw.abstract)),
      doi: normalizeDoi(raw.DOI),
      isbn: firstArrayString(raw.ISBN),
      issn: firstArrayString(raw.ISSN),
      url: string(raw.URL),
      journal: firstArrayString(raw["container-title"]),
      volume: string(raw.volume),
      issue: string(raw.issue),
      pages: string(raw.page),
      publisher: string(raw.publisher),
      language: string(raw.language),
      tags: [],
    }),
    provider: "crossref",
    confidence,
    reason,
    raw,
  };
}

function canonicalFromCitoid(raw: Record<string, unknown>): PaperCanonical {
  return cleanCanonical({
    itemType: string(raw.itemType) || "journalArticle",
    title: string(raw.title) || "未命名文献",
    creators: Array.isArray(raw.creators) ? raw.creators.filter(isRecord).map((creator) => ({
      family: string(creator.lastName ?? creator.family),
      given: string(creator.firstName ?? creator.given),
      creatorType: string(creator.creatorType) || "author",
    })) : [],
    date: string(raw.date),
    abstract: string(raw.abstractNote),
    doi: normalizeDoi(raw.DOI),
    isbn: string(raw.ISBN),
    issn: string(raw.ISSN),
    url: string(raw.url),
    journal: string(raw.publicationTitle),
    volume: string(raw.volume),
    issue: string(raw.issue),
    pages: string(raw.pages),
    publisher: string(raw.publisher),
    language: string(raw.language),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => isRecord(tag) ? string(tag.tag) : string(tag)).filter(Boolean) : [],
  });
}

export function parseCnkiHtml(html: string): MetadataCandidate[] {
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(
      "a.fz14, a[href*='/kcms/detail/detail.aspx'], .result-table-list a.name",
    ));
    return links.slice(0, 10).map((link) => {
      const row = link.closest("tr, .result-table-list") ?? link.parentElement;
      const author = row?.querySelector<HTMLElement>(".author, td.author")?.textContent ?? "";
      const year = row?.textContent?.match(/(?:19|20)\d{2}/)?.[0];
      return cnkiCandidate(link.textContent ?? "", author, year, link.href);
    }).filter((candidate) => candidate.canonical.title.length > 1);
  }
  const matches = [...html.matchAll(/<a[^>]+href="([^"]*\/kcms\/detail\/detail\.aspx[^"]*)"[^>]*>(.*?)<\/a>/gis)];
  return matches.slice(0, 10).map((match) => cnkiCandidate(stripTags(match[2] ?? ""), "", undefined, match[1]));
}

function cnkiCandidate(title: string, author: string, year: string | undefined, url: string | undefined): MetadataCandidate {
  return {
    canonical: cleanCanonical({
      itemType: "journalArticle",
      title: stripTags(title),
      creators: splitAuthors(author),
      date: year,
      url,
      tags: [],
    }),
    provider: "cnki",
    confidence: 0,
    reason: "CNKI 候选",
    raw: { title, author, year, url },
  };
}

function metadataConfidence(local: PaperCanonical, candidate: PaperCanonical): number {
  const titleScore = titleSimilarity(local.title, candidate.title);
  const localYear = local.date?.match(/\d{4}/)?.[0];
  const candidateYear = candidate.date?.match(/\d{4}/)?.[0];
  const yearMatch = Boolean(localYear && candidateYear && localYear === candidateYear);
  const localAuthor = local.creators[0]?.family.toLowerCase();
  const candidateAuthor = candidate.creators[0]?.family.toLowerCase();
  const authorMatch = Boolean(localAuthor && candidateAuthor && (localAuthor.includes(candidateAuthor) || candidateAuthor.includes(localAuthor)));
  const supporting = yearMatch || authorMatch;
  return Math.min(0.99, titleScore * 0.82 + (yearMatch ? 0.09 : 0) + (authorMatch ? 0.09 : 0) - (!supporting && titleScore < 0.98 ? 0.08 : 0));
}

function mergeMetadata(local: MetadataCandidate, provider: MetadataCandidate): MetadataCandidate {
  const merged = { ...provider.canonical };
  for (const [key, value] of Object.entries(local.canonical)) {
    if ((merged as Record<string, unknown>)[key] == null || (merged as Record<string, unknown>)[key] === "") {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return { ...provider, canonical: cleanCanonical(merged), confidence: Math.max(local.confidence, provider.confidence) };
}

function dedupeCandidates(candidates: MetadataCandidate[]): MetadataCandidate[] {
  const map = new Map<string, MetadataCandidate>();
  for (const candidate of candidates) {
    const key = candidate.canonical.doi || candidate.canonical.title.toLowerCase();
    const existing = map.get(key);
    if (!existing || candidate.confidence > existing.confidence) map.set(key, candidate);
  }
  return [...map.values()];
}

function findDoi(text: string): string | undefined {
  const matches = text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi) ?? [];
  return matches.map(normalizeDoi).find(Boolean);
}

function datePartsFromCrossref(raw: Record<string, unknown>): string | undefined {
  for (const key of ["published-print", "published-online", "published", "issued"]) {
    const value = raw[key];
    if (!isRecord(value) || !Array.isArray(value["date-parts"])) continue;
    const parts = value["date-parts"][0];
    if (Array.isArray(parts)) return parts.filter((part) => Number.isFinite(Number(part))).join("-");
  }
  return undefined;
}

function filenameTitle(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || "未命名文献";
}

function splitAuthors(value: string): PaperCreator[] {
  return value.split(/[;；、]|\s+and\s+/i).map((name) => name.trim()).filter(Boolean).map((name) => {
    if (containsCjk(name) && !name.includes(" ")) return { family: name.slice(0, 1), given: name.slice(1), creatorType: "author" };
    const parts = name.split(/\s+/);
    return { family: parts.at(-1) ?? name, given: parts.slice(0, -1).join(" "), creatorType: "author" };
  });
}

function splitTags(value: string): string[] {
  return value.split(/[,;；、]/).map((tag) => tag.trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string {
  return values.map(string).find(Boolean) ?? "";
}

function firstArrayString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(string).find(Boolean);
  return string(value) || undefined;
}

function crossrefType(value: string): string {
  if (value.includes("journal")) return "journalArticle";
  if (value.includes("proceedings")) return "conferencePaper";
  if (value.includes("book")) return "book";
  return value || "journalArticle";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
