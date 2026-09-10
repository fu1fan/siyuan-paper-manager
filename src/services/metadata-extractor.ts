import { recognizerPage } from "./zotero-recognizer";
import { metadataFetch } from "./metadata-http";
import { bibtexCandidates } from "./bibtex-input";
import { englishPdfMetadata } from "./english-pdf";
import { desktopCnkiClient } from "./cnki-desktop";
import { trustedCnkiUrl, type CnkiClient, type CnkiRegion } from "./cnki-client";
import { parseCnkiDetail, parseCnkiEndnote } from "./cnki-metadata";
import type { TextItem, DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import type { ExtractionResult, MetadataCandidate } from "../types/import";
import type { PaperCanonical, PaperCreator } from "../types/paper";
import { cleanCanonical } from "../core/normalize";
import { normalizeDoi, titleSimilarity } from "../core/naming";
import { containsHan, splitChineseName } from "../core/chinese";
import { chineseLayoutTitle, pdfTextLines, type PdfLine } from "./pdf-layout";
import { extractChineseThesis } from "./chinese-thesis";
import { pdfDocumentOptions } from "./pdf-runtime";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfMetadataSnapshot {
  info: Record<string, unknown>;
  xmp: Record<string, string>;
  text: string;
  pages?: PdfLine[][];
  recognizer?: { metadata: Record<string, unknown>; totalPages: number; pages: unknown[][] };
}

export interface MetadataExtractorOptions {
  fetchImpl?: typeof fetch;
  enableCnki?: boolean;
  enableZoteroRecognizer?: boolean;
  cnkiClient?: CnkiClient;
  cnkiRegion?: CnkiRegion;
  cnkiTimeoutSeconds?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  pdfOptions?: Partial<DocumentInitParameters>;
}

export class MetadataExtractor {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: MetadataExtractorOptions = {}) {
    const fetchImpl = options.fetchImpl ?? metadataFetch;
    // Keep the browser receiver for Electron/Chromium native fetch. Invoking a
    // raw fetch reference as `this.fetchImpl()` otherwise throws Illegal invocation.
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async extract(bytes: Uint8Array, filename: string): Promise<ExtractionResult> {
    const warnings: string[] = [];
    let snapshot: PdfMetadataSnapshot = { info: {}, xmp: {}, text: "" };
    try {
      snapshot = await inspectPdf(bytes, this.options.pdfOptions);
    } catch (error) {
      warnings.push(`PDF 本地解析失败：${message(error)}`);
    }
    this.options.signal?.throwIfAborted();
    const detectedDoi = findDoi(snapshot.pages?.slice(0, 3).flatMap((page) => page.map((line) => line.text)).join("\n") ?? snapshot.text)
      ?? normalizeDoi(snapshot.info.DOI ?? snapshot.xmp.doi);
    const local = localCandidate(snapshot, filename, detectedDoi);
    const candidates: MetadataCandidate[] = [local];

    const arxiv = findArxiv(snapshot.pages?.slice(0, 2).flatMap(page => page.map(line => line.text)).join("\n") ?? "");
    if (arxiv) {
      local.canonical.url ||= `https://arxiv.org/abs/${arxiv}`;
      try { candidates.push(...(await this.lookup(`arXiv:${arxiv}`)).candidates); }
      catch (error) { warnings.push(`arXiv 补充失败：${message(error)}`); }
    }
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
    } else if (!candidates.some(candidate => candidate.provider === "arxiv") && local.canonical.title && !containsCjk(local.canonical.title) && local.provider !== "filename") {
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
        warnings.push(`知网在线补充检索未完成（${message(error)}）；已有候选仍可使用，请核对后导入。如不需要联网补充，可在设置中关闭「中文检索（实验性）」`);
      }
    }

    if (this.options.enableZoteroRecognizer && snapshot.recognizer && snapshot.text.trim()) {
      try {
        const response = await this.fetchWithRetry("https://services.zotero.org/recognizer/recognize", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...snapshot.recognizer, fileName: filename }),
        }, 1);
        const raw: unknown = await response.json();
        if (isRecord(raw)) {
          if (string(raw.title)) candidates.push({ provider: "zotero", confidence: 0.93, reason: "Zotero 在线识别（请核对）", raw,
            canonical: canonicalFromCitoid({ ...raw, creators: raw.authors, date: raw.year, abstractNote: raw.abstract, DOI: raw.doi, publicationTitle: raw.container }) });
          const identifier = string(raw.arxiv) ? `arXiv:${raw.arxiv}` : string(raw.doi) || string(raw.isbn);
          if (identifier && !candidates.some(candidate => candidate.provider === "arxiv" && findArxiv(candidate.canonical.url ?? "")?.replace(/v\d+$/, "") === findArxiv(identifier)?.replace(/v\d+$/, ""))) {
            try { candidates.push(...(await this.lookup(identifier)).candidates); }
            catch (error) { this.options.signal?.throwIfAborted(); warnings.push(`Zotero 标识符补充失败：${message(error)}`); }
          }
        }
      } catch (error) { this.options.signal?.throwIfAborted(); warnings.push(`Zotero 在线识别失败：${message(error)}`); }
    }
    this.options.signal?.throwIfAborted();
    const deduplicated = dedupeCandidates(candidates).sort((left, right) => right.confidence - left.confidence);
    const best = deduplicated[0] ?? filenameCandidate(filename, detectedDoi);
    const selected = local.canonical.itemType === "thesis" && local.canonical.creators.length && local.canonical.date
      ? local
      : mergeMetadata(local, best);
    return { selected, candidates: deduplicated, detectedDoi, warnings };
  }

  /** BibLib-style identifier lookup, using structured Zotero JSON from Citoid. */
  async lookup(input: string): Promise<ExtractionResult> {
    this.options.signal?.throwIfAborted();
    const value = input.trim();
    if (!value) throw new Error("请输入 DOI、URL、arXiv、ISBN、PMID 或 PMCID");
    if (value.startsWith("@")) {
      const candidates = bibtexCandidates(value);
      if (!candidates.length) throw new Error("BibTeX 中没有可识别的文献");
      return { selected: candidates[0]!, candidates, warnings: [] };
    }
    const doi = findDoi(value);
    const arxiv = findArxiv(value);
    const target = doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}`
      : /^PMID\s*:\s*(\d+)$/i.test(value) ? `https://pubmed.ncbi.nlm.nih.gov/${value.match(/\d+/)![0]}/`
      : /^(?:PMCID\s*:\s*)?PMC\d+$/i.test(value) ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${value.match(/PMC\d+/i)![0].toUpperCase()}/`
      : value.replace(/^ISBN(?:-1[03])?\s*:\s*/i, "");
    const candidates: MetadataCandidate[] = [];
    const warnings: string[] = [];
    if (doi) {
      try { const candidate = await this.crossrefByDoi(doi); if (candidate) candidates.push(candidate); }
      catch (error) { this.options.signal?.throwIfAborted(); warnings.push(`Crossref：${message(error)}`); }
    }
    if (arxiv) {
      try {
        const response = await this.fetchWithRetry(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxiv)}`, {});
        const candidate = arxivCandidate(await response.text());
        if (candidate) candidates.push(candidate);
      } catch (error) { this.options.signal?.throwIfAborted(); warnings.push(`arXiv：${message(error)}`); }
    }
    if (!candidates.length) {
      try {
        const candidate = await this.citoidByDoi(target);
        if (candidate && candidate.canonical.title !== "未命名文献") candidates.push(candidate);
      } catch (error) { this.options.signal?.throwIfAborted(); warnings.push(`Citoid：${message(error)}`); }
    }
    this.options.signal?.throwIfAborted();
    if (!candidates.length) throw new Error(warnings.join("；") || "没有找到元数据，请检查标识符或网址");
    return { selected: candidates[0]!, candidates, detectedDoi: doi, warnings };
  }

  private async crossrefByDoi(doi: string): Promise<MetadataCandidate | null> {
    const response = await this.fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    const message = isRecord(response) && isRecord(response.message) ? response.message : null;
    return message ? crossrefCandidate(message, 1, "DOI 精确匹配") : null;
  }

  private async crossrefByTitle(local: PaperCanonical): Promise<MetadataCandidate[]> {
    const query = new URLSearchParams({ "query.title": local.title, rows: "5", select: "DOI,title,author,published,container-title,publisher,URL,abstract,volume,issue,page,type,ISBN,ISSN" });
    const response = await this.fetchJson(`https://api.crossref.org/works?${query.toString()}`);
    const items = isRecord(response) && isRecord(response.message) && Array.isArray(response.message.items)
      ? response.message.items.filter(isRecord)
      : [];
    return items.map((item) => {
      const candidate = crossrefCandidate(item, 0, "标题检索");
      const score = metadataConfidence(local, candidate.canonical);
      return { ...candidate, confidence: score, reason: `Crossref 标题相似度 ${score.toFixed(2)}` };
    }).filter((candidate) => candidate.confidence >= (local.itemType === "thesis" ? 0.9 : 0.55));
  }

  private async citoidByDoi(doi: string): Promise<MetadataCandidate | null> {
    const target = encodeURIComponent(/^10\./.test(doi) ? `https://doi.org/${doi}` : doi);
    const response = await this.fetchJson(`https://en.wikipedia.org/api/rest_v1/data/citation/zotero/${target}`);
    const raw = Array.isArray(response) ? response.find(isRecord) : isRecord(response) ? response : null;
    if (!raw) return null;
    return {
      canonical: canonicalFromCitoid(raw),
      provider: "citoid",
      confidence: 0.98,
      reason: "Citoid 标识符/网址检索（请核对）",
      raw,
    };
  }

  private async cnkiByTitle(local: PaperCanonical): Promise<MetadataCandidate[]> {
    const client = this.options.cnkiClient ?? desktopCnkiClient(undefined, this.options.cnkiTimeoutSeconds);
    const response = await client.search(local, this.options.cnkiRegion, this.options.signal);
    const html = response.text;
    const candidates = parseCnkiHtml(html, response.url).map((candidate) => {
      const confidence = metadataConfidence(local, candidate.canonical);
      return { ...candidate, confidence, reason: `CNKI 标题相似度 ${confidence.toFixed(2)}` };
    }).filter((candidate) => candidate.confidence >= (local.itemType === "thesis" ? 0.9 : 0.55))
      .sort((a, b) => b.confidence - a.confidence);
    if (!candidates.length && !/result-table-list|没有找到|未找到|暂无|无检索结果|no results/i.test(html)) {
      throw new Error("知网未返回可识别的搜索结果，页面结构可能已变化");
    }
    for (const candidate of candidates.slice(0, 1)) {
      this.options.signal?.throwIfAborted();
      const region = this.options.cnkiRegion ?? "mainland";
      const notes: string[] = [];
      const failed = (error: unknown, stage: string) => {
        if (this.options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        notes.push(`${stage}未完成：${message(error)}`);
      };
      try {
        const detail = await client.requestVerified({ url: trustedCnkiUrl(candidate.canonical.url!), method: "GET", headers: { Accept: "text/html", Referer: response.url } }, region, this.options.signal);
        candidate.canonical = parseCnkiDetail(detail.text, candidate.canonical);
      } catch (error) { failed(error, "详情补充"); }
      const raw = candidate.raw as { exportId?: string };
      if (region === "mainland" && raw.exportId) {
        try {
          const exported = await client.requestVerified({
            url: "https://kns.cnki.net/dm8/API/GetExport", method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: candidate.canonical.url!, Origin: "https://kns.cnki.net" },
            body: new URLSearchParams({ filename: raw.exportId, uniplatform: "NZKPT", displaymode: "EndNote" }).toString(),
          }, region, this.options.signal);
          candidate.canonical = parseCnkiEndnote(exported.text, candidate.canonical);
        } catch (error) { failed(error, "EndNote补充"); }
      }
      candidate.confidence = metadataConfidence(local, candidate.canonical);
      candidate.reason = [`CNKI 标题相似度 ${candidate.confidence.toFixed(2)}`, ...notes].join("；");
    }
    return candidates;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchWithRetry(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "siyuan-paper-manager/0.4.0 (+https://github.com/fu1fan/siyuan-paper-manager)",
      },
    });
    return response.json();
  }

  private async fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.options.signal?.throwIfAborted();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (response.ok) return response;
        if (response.status !== 429 && response.status < 500) throw new PermanentHttpError(`HTTP ${response.status}`);
        lastError = new Error(`HTTP ${response.status}`);
        const retryAfter = Math.min(5_000, Number(response.headers.get("Retry-After") || 0) * 1000);
        if (attempt + 1 < attempts) await sleep(retryAfter || 300 * 2 ** attempt);
      } catch (error) {
        if (this.options.signal?.aborted || error instanceof PermanentHttpError) throw error;
        lastError = controller.signal.aborted ? new Error(`请求超时（${this.timeoutMs / 1000}秒）`) : error;
        if (controller.signal.aborted) throw lastError;
        if (attempt + 1 < attempts) await sleep(300 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", cancel);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("网络请求失败");
  }
}

export async function inspectPdf(bytes: Uint8Array, options: Partial<DocumentInitParameters> = pdfDocumentOptions()): Promise<PdfMetadataSnapshot> {
  const loading = pdfjs.getDocument({
    ...options,
    data: bytes.slice(),
  });
  try {
    const document = await loading.promise;
    const metadata = await document.getMetadata().catch(() => null);
    const info = metadata?.info && typeof metadata.info === "object"
      ? metadata.info as unknown as Record<string, unknown>
      : {};
    const xmp: Record<string, string> = {};
    const xmpObject = metadata?.metadata as { get?: (key: string) => unknown } | null | undefined;
    for (const key of ["dc:title", "dc:creator", "dc:description", "dc:subject", "prism:doi"]) {
      const value = xmpObject?.get?.(key);
      if (typeof value === "string") xmp[key === "prism:doi" ? "doi" : key] = value;
      else if (Array.isArray(value)) xmp[key] = value.filter((item) => typeof item === "string").join("; ");
    }
    const pages: PdfLine[][] = [];
    const recognizerPages: unknown[][] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(8, document.numPages); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      if (pageNumber <= 5) {
        const viewport = page.getViewport({ scale: 1 });
        recognizerPages.push(recognizerPage(viewport.width, viewport.height, content.items.filter((item): item is TextItem => "str" in item)));
      }
      pages.push(pdfTextLines(content.items.filter((item): item is TextItem => "str" in item)));
      page.cleanup();
    }
    return { info, xmp, recognizer: { metadata: Object.fromEntries(Object.entries(info).filter(([, value]) => typeof value === "string")), totalPages: document.numPages, pages: recognizerPages }, text: pages.map((lines) => lines.map((line) => line.text).join("\n")).join("\n"), pages };
  } finally {
    await loading.destroy();
  }
}

export function localCandidate(snapshot: PdfMetadataSnapshot, filename: string, doi?: string): MetadataCandidate {
  const embedded = firstString(snapshot.xmp["dc:title"], snapshot.info.Title);
  const usableEmbedded = embedded && !/^(?:untitled|未命名|Microsoft (?:Word|PowerPoint)|WPS|document\d*|CNKI)/i.test(embedded) ? embedded : "";
  const layout = !usableEmbedded || !containsHan(usableEmbedded) ? chineseLayoutTitle(snapshot.pages?.slice(0, 3) ?? []) : undefined;
  const thesis = extractChineseThesis(snapshot.pages ?? []);
  const english = !layout && !containsHan(usableEmbedded) ? englishPdfMetadata(snapshot.pages ?? []) : undefined;
  let title = layout?.title || usableEmbedded || english?.title || filenameTitle(filename);
  const fileTitle = filename.replace(/_[^_]+\.pdf$/i, "");
  if (title.replace(/DC[.．]DC/gi, "DC-DC") === fileTitle) title = fileTitle;
  const author = firstString(snapshot.xmp["dc:creator"], snapshot.info.Author);
  const creators = thesis.author ? splitAuthors(thesis.author) : author && !/^(?:CNKI|TTKN|万方数据|Administrator|admin)$/i.test(author) ? splitAuthors(author) : english?.creators ?? [];
  const canonical = cleanCanonical({
    itemType: thesis.isThesis || layout?.thesis ? "thesis" : "journalArticle",
    title,
    creators,
    publisher: thesis.publisher,
    date: thesis.date,
    // PDF creation time is not the publication date.
    language: containsHan(title) ? "zh-CN" : undefined,
    abstract: thesis.abstract || english?.abstract || firstString(snapshot.xmp["dc:description"], snapshot.info.Subject),
    doi,
    tags: thesis.tags.length ? thesis.tags : splitTags(firstString(snapshot.xmp["dc:subject"], snapshot.info.Keywords)),
  });
  const hasEmbedded = title !== filenameTitle(filename) || creators.length > 0;
  return {
    canonical,
    provider: layout || english || thesis.author ? "pdf-text" : hasEmbedded ? "xmp" : "filename",
    confidence: thesis.author && thesis.date && thesis.publisher ? 0.94 : doi ? 0.72 : english ? 0.82 : layout ? 0.68 : hasEmbedded ? 0.58 : 0.3,
    reason: english ? "PDF 英文首页标题与作者（字号与位置识别，请核对）" : thesis.author ? "PDF 学位论文封面与摘要（请核对）" : layout ? "PDF 中文标题（字号与位置识别，请核对）" : hasEmbedded ? "PDF 内嵌元数据" : "文件名兜底",
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

export function parseCnkiHtml(html: string, baseUrl = "https://kns.cnki.net"): MetadataCandidate[] {
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(
      "a.fz14, a[href*='/kcms/detail/detail.aspx'], .result-table-list a.name",
    ));
    return links.slice(0, 10).map((link) => {
      const row = link.closest("tr, .result-table-list") ?? link.parentElement;
      const authorCell = row?.querySelector<HTMLElement>(".author, td.author");
      const authorLinks = Array.from(authorCell?.querySelectorAll("a") ?? []);
      const author = authorLinks.length ? authorLinks.map((node) => node.textContent?.trim()).filter(Boolean).join("；") : authorCell?.textContent ?? "";
      const year = (row?.querySelector(".date")?.textContent ?? row?.textContent)?.match(/(?:19|20)\d{2}(?:[-/]\d{1,2}){0,2}/)?.[0];
      const candidate = cnkiCandidate(link.textContent ?? "", author, year, new URL(link.getAttribute("href") ?? "", baseUrl).href);
      const source = row?.querySelector(".source")?.textContent?.trim();
      const kind = row?.querySelector(".data")?.textContent ?? "";
      if (/硕士|博士|学位/.test(kind)) {
        candidate.canonical.itemType = "thesis";
        candidate.canonical.publisher = source;
      } else candidate.canonical.journal = source;
      candidate.raw = { ...(candidate.raw as object), exportId: row?.querySelector("td.seq input")?.getAttribute("value") ?? undefined };
      return candidate;
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

export function mergeMetadata(local: MetadataCandidate, provider: MetadataCandidate): MetadataCandidate {
  const merged = { ...provider.canonical };
  const authors = local.canonical.creators;
  const sameName = (name: string) => name.toLowerCase().replace(/[^\p{L}]/gu, "");
  if (provider.provider === "zotero" && titleSimilarity(local.canonical.title, provider.canonical.title) > 0.95
      && authors.length > merged.creators.length && merged.creators.every((author, index) => {
        const known = authors[index];
        return known && sameName(author.family + author.given) === sameName(known.family + known.given);
      })) merged.creators = authors;

  for (const [key, value] of Object.entries(local.canonical)) {
    const current = (merged as Record<string, unknown>)[key];
    if (current == null || current === "" || (Array.isArray(current) && current.length === 0)) {
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
    if (!existing) map.set(key, candidate);
    else map.set(key, candidate.confidence > existing.confidence ? mergeMetadata(existing, candidate) : mergeMetadata(candidate, existing));
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
  return value.split(/[;；、，]|\s+and\s+/i).map((name) => name.trim()).filter(Boolean).map((name) => {
    const chinese = splitChineseName(name);
    if (chinese) return { ...chinese, creatorType: "author" };
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

class PermanentHttpError extends Error {}

export function findArxiv(text: string): string | undefined {
  return text.match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i)?.[1]
    ?? text.trim().match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/)?.[1];
}

export function arxivCandidate(xml: string): MetadataCandidate | undefined {
  const entry = xml.match(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return;
  const field = (tag: string, source = entry) => stripTags(source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();
  const title = field("title");
  const url = field("id").replace(/^http:/, "https:");
  if (!title || !/arxiv\.org\/abs\//.test(url)) return;
  // The Atom DOI field describes the published version and is optional.
  // arXiv's own DataCite DOI identifies the record, without a version suffix.
  const arxivId = findArxiv(url)?.replace(/v\d+$/i, "");
  const creators = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/g)].flatMap(match => splitAuthors(field("name", match[1])));
  return { provider: "arxiv", confidence: 0.99, reason: "arXiv 编号精确检索", raw: { xml }, canonical: cleanCanonical({
    itemType: "journalArticle", title, creators, date: field("published").slice(0, 10), abstract: field("summary"), url,
    doi: field("arxiv:doi") || (arxivId ? `10.48550/arXiv.${arxivId}` : undefined), journal: field("arxiv:journal_ref"), tags: [],
  }) };
}
