import type { PaperData } from "../types/paper";

export type CitationExportFormat =
  | "gbt-numeric"
  | "gbt-author-year"
  | "apa7"
  | "ieee"
  | "bibtex"
  | "biblatex"
  | "hayagriva"
  | "latex-cite"
  | "latex-parencite"
  | "latex-textcite"
  | "typst-key"
  | "typst-cite";

export interface CitationExportResult {
  content: string;
  warnings: string[];
  extension: "txt" | "bib" | "yaml";
  mimeType: string;
}

export const CITATION_FORMAT_LABELS: Record<CitationExportFormat, string> = {
  "gbt-numeric": "GB/T 7714—2015（顺序编码）",
  "gbt-author-year": "GB/T 7714—2015（著者—出版年）",
  apa7: "APA 7",
  ieee: "IEEE",
  bibtex: "BibTeX",
  biblatex: "BibLaTeX",
  hayagriva: "Typst Hayagriva YAML",
  "latex-cite": "LaTeX \\cite",
  "latex-parencite": "LaTeX \\parencite",
  "latex-textcite": "LaTeX \\textcite",
  "typst-key": "Typst @key",
  "typst-cite": "Typst #cite",
};

export function exportCitations(papers: PaperData[], format: CitationExportFormat): CitationExportResult {
  const warnings = papers.flatMap(validationWarnings);
  const entries = papers.map((paper, index) => formatPaper(paper, format, index));
  const extension = format === "bibtex" || format === "biblatex" ? "bib" : format === "hayagriva" ? "yaml" : "txt";
  return {
    content: compactCitation(format) ? entries.join(format.startsWith("typst") ? " " : "\n") : entries.join("\n\n"),
    warnings,
    extension,
    mimeType: extension === "bib" ? "application/x-bibtex;charset=utf-8" : extension === "yaml" ? "application/yaml;charset=utf-8" : "text/plain;charset=utf-8",
  };
}

function formatPaper(paper: PaperData, format: CitationExportFormat, index: number): string {
  switch (format) {
    case "gbt-numeric": return `[${index + 1}] ${gbtEntry(paper)}.`;
    case "gbt-author-year": return `${gbtEntry(paper)}.`;
    case "apa7": return apaEntry(paper);
    case "ieee": return `[${index + 1}] ${ieeeEntry(paper)}`;
    case "bibtex": return bibEntry(paper, false);
    case "biblatex": return bibEntry(paper, true);
    case "hayagriva": return hayagrivaEntry(paper);
    case "latex-cite": return `\\cite{${latex(paper.citekey)}}`;
    case "latex-parencite": return `\\parencite{${latex(paper.citekey)}}`;
    case "latex-textcite": return `\\textcite{${latex(paper.citekey)}}`;
    case "typst-key": return `@${typstKey(paper.citekey)}`;
    case "typst-cite": return `#cite(<${typstKey(paper.citekey)}>)`;
  }
}

function gbtEntry(paper: PaperData): string {
  const c = paper.canonical;
  const authors = authorDisplay(paper, "，");
  const type = itemTypeCode(c.itemType);
  const publication = [c.journal, c.date, c.volume && c.issue ? `${c.volume}(${c.issue})` : c.volume || c.issue, c.pages].filter(Boolean).join(", ");
  const publisher = [c.publisherPlace, c.publisher, year(paper)].filter(Boolean).join(": ");
  const tail = publication || publisher;
  return `${authors ? `${authors}. ` : ""}${c.title}[${type}]${tail ? `. ${tail}` : ""}${c.doi ? `. DOI:${c.doi}` : ""}`;
}

function apaEntry(paper: PaperData): string {
  const c = paper.canonical;
  const authors = c.creators.filter((creator) => creator.creatorType === "author").map((creator) => `${creator.family}, ${initials(creator.given)}`).join(", ") || "Anonymous";
  const source = c.journal ? ` *${c.journal}*${c.volume ? `, *${c.volume}*` : ""}${c.issue ? `(${c.issue})` : ""}${c.pages ? `, ${c.pages}` : ""}.` : c.publisher ? ` ${c.publisher}.` : "";
  return `${authors} (${year(paper) || "n.d."}). ${c.title}.${source}${c.doi ? ` https://doi.org/${c.doi}` : c.url ? ` ${c.url}` : ""}`;
}

function ieeeEntry(paper: PaperData): string {
  const c = paper.canonical;
  const authors = c.creators.filter((creator) => creator.creatorType === "author").map((creator) => `${initials(creator.given)} ${creator.family}`.trim()).join(", ") || "Anonymous";
  return `${authors}, “${c.title},” ${c.journal ? `*${c.journal}*, ` : ""}${c.volume ? `vol. ${c.volume}, ` : ""}${c.issue ? `no. ${c.issue}, ` : ""}${c.pages ? `pp. ${c.pages}, ` : ""}${year(paper) || "n.d."}.${c.doi ? ` doi: ${c.doi}.` : ""}`;
}

function bibEntry(paper: PaperData, biblatex: boolean): string {
  const c = paper.canonical;
  const fields: Array<[string, string | undefined]> = [
    ["title", c.title],
    ["author", bibAuthors(paper, "author")],
    ["editor", bibAuthors(paper, "editor")],
    [biblatex ? "date" : "year", biblatex ? c.date : year(paper)],
    ["journaltitle", biblatex ? c.journal : undefined],
    ["journal", biblatex ? undefined : c.journal],
    ["volume", c.volume], ["number", c.issue], ["pages", c.pages],
    ["publisher", c.publisher], ["location", biblatex ? c.publisherPlace : undefined],
    ["address", biblatex ? undefined : c.publisherPlace], ["edition", c.edition],
    ["doi", c.doi], ["isbn", c.isbn], ["issn", c.issn], ["url", c.url],
    ["langid", c.language], ["abstract", c.abstract], ["keywords", c.tags.join(", ")],
  ];
  const body = fields.filter((entry): entry is [string, string] => Boolean(entry[1])).map(([key, value]) => `  ${key} = {${latex(value)}},`).join("\n");
  return `@${bibType(c.itemType)}{${typstKey(paper.citekey)},\n${body}\n}`;
}

function hayagrivaEntry(paper: PaperData): string {
  const c = paper.canonical;
  const authors = c.creators.filter((creator) => creator.creatorType === "author");
  const lines = [`${typstKey(paper.citekey)}:`, `  type: ${yamlScalar(hayagrivaType(c.itemType))}`, `  title: ${yamlScalar(c.title)}`];
  if (authors.length) {
    lines.push("  author:");
    for (const author of authors) lines.push(`    - family: ${yamlScalar(author.family)}\n      given: ${yamlScalar(author.given)}`);
  }
  if (c.date) lines.push(`  date: ${yamlScalar(c.date)}`);
  if (c.journal) lines.push(`  parent:\n    type: periodical\n    title: ${yamlScalar(c.journal)}`);
  for (const [key, value] of [["volume", c.volume], ["issue", c.issue], ["page-range", c.pages], ["publisher", c.publisher], ["doi", c.doi], ["url", c.url]] as const) {
    if (value) lines.push(`  ${key}: ${yamlScalar(value)}`);
  }
  return lines.join("\n");
}

function validationWarnings(paper: PaperData): string[] {
  const missing = [];
  if (!paper.canonical.creators.some((creator) => creator.creatorType === "author")) missing.push("作者");
  if (!year(paper)) missing.push("年份");
  if (!paper.canonical.journal && !paper.canonical.publisher) missing.push("来源/出版社");
  return missing.length ? [`${paper.citekey} 缺少：${missing.join("、")}`] : [];
}

function authorDisplay(paper: PaperData, separator: string): string {
  return paper.canonical.creators.filter((creator) => creator.creatorType === "author").map((creator) => `${creator.family}${creator.given ? ` ${creator.given}` : ""}`).join(separator);
}
function bibAuthors(paper: PaperData, role: string): string {
  return paper.canonical.creators.filter((creator) => creator.creatorType === role).map((creator) => `${creator.family}, ${creator.given}`.trim()).join(" and ");
}
function year(paper: PaperData): string { return paper.canonical.date?.match(/\d{4}/)?.[0] ?? ""; }
function initials(value: string): string { return value.split(/\s+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}.`).join(" "); }
function itemTypeCode(type: string): string { return /book/i.test(type) ? "M" : /conference|proceedings/i.test(type) ? "C" : /thesis/i.test(type) ? "D" : "J"; }
function bibType(type: string): string { return /bookSection|chapter/i.test(type) ? "incollection" : /book/i.test(type) ? "book" : /conference|proceedings/i.test(type) ? "inproceedings" : /thesis/i.test(type) ? "phdthesis" : "article"; }
function hayagrivaType(type: string): string { return /book/i.test(type) ? "book" : /conference/i.test(type) ? "article" : "article"; }
function compactCitation(format: CitationExportFormat): boolean { return format.startsWith("latex-") || format.startsWith("typst-"); }
export function latex(value: string): string {
  const escapes: Record<string, string> = {
    "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  };
  return value.replace(/[\\#$%&_{}~^]/g, (char) => escapes[char] ?? `\\${char}`);
}
function typstKey(value: string): string { return value.replace(/[^\p{L}\p{N}_:\-.]/gu, "-"); }
function yamlScalar(value: string): string { return JSON.stringify(value.replace(/\r?\n/g, " ")); }
