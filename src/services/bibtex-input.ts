import { Cite } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import { cleanCanonical } from "../core/normalize";
import type { MetadataCandidate } from "../types/import";

export function bibtexCandidates(input: string): MetadataCandidate[] {
  return new Cite(input).data.filter(raw => typeof raw.title === "string").map(raw => {
    const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : undefined;
    const issued = raw.issued as { "date-parts"?: number[][] } | undefined;
    const authors = raw.author as Array<{ family?: string; given?: string; literal?: string }> | undefined;
    return {
      provider: "bibtex", confidence: 1, reason: "本地解析 BibTeX（请核对）", raw,
      canonical: cleanCanonical({
        itemType: ({ "article-journal": "journalArticle", "paper-conference": "conferencePaper", thesis: "thesis", book: "book", chapter: "bookSection" } as Record<string, string>)[String(raw.type)] ?? "journalArticle",
        title: String(raw.title), creators: (authors ?? []).map(a => ({ family: a.family || a.literal || "", given: a.given || "", creatorType: "author" })),
        date: issued?.["date-parts"]?.[0]?.join("-"), doi: text("DOI"), url: text("URL"), journal: text("container-title"), publisher: text("publisher"),
        abstract: text("abstract"), volume: text("volume"), issue: text("issue"), pages: text("page"), isbn: text("ISBN"), issn: text("ISSN"), tags: [],
      }),
    };
  });
}
