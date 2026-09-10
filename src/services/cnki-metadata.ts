import { cleanCanonical } from "../core/normalize";
import { splitChineseName } from "../core/chinese";
import { normalizeDoi } from "../core/naming";
import type { PaperCanonical, PaperCreator } from "../types/paper";

function creator(name: string): PaperCreator {
  const chinese = splitChineseName(name.trim());
  if (chinese) return { ...chinese, creatorType: "author" };
  const [family, ...given] = name.trim().split(/,\s*/);
  return { family: family ?? "", given: given.join(" "), creatorType: "author" };
}

/** Parse the public detail page without running its scripts. */
export function parseCnkiDetail(html: string, fallback: PaperCanonical): PaperCanonical {
  if (typeof DOMParser === "undefined") return fallback;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (selector: string) => doc.querySelector(selector)?.textContent?.trim() ?? "";
  const labelled = new Map<string, string>();
  for (const row of doc.querySelectorAll(".row")) {
    const label = row.querySelector(".rowtit")?.textContent?.replace(/[：:\s]/g, "");
    const value = row.querySelector(".rowcont")?.textContent?.trim();
    if (label && value) labelled.set(label, value);
  }
  const type = doc.querySelector<HTMLInputElement>("#dbCode, #dbcode")?.value ?? "";
  const thesis = /CMFD|CDFD|CDMH/i.test(type) || fallback.itemType === "thesis";
  const authorNodes = [...doc.querySelectorAll("#authorpart a")];
  const names = authorNodes.length ? authorNodes.map((node) => node.textContent?.trim() ?? "") : text("#authorpart").split(/[;；,，]/);
  const authors = names.filter(Boolean).map(creator);
  const tags = (labelled.get("关键词") ?? "").split(/[;；、]/).map((value) => value.trim()).filter(Boolean);
  return cleanCanonical({ ...fallback,
    title: text(".wx-tit > h1") || fallback.title,
    itemType: thesis ? "thesis" : fallback.itemType,
    creators: authors.length ? authors : fallback.creators,
    publisher: thesis ? text('.top-tip a[href*="/knavi/"]') || fallback.publisher : fallback.publisher,
    date: text("#ndate").match(/(?:19|20)\d{2}(?:[-/]\d{1,2}){0,2}/)?.[0] || fallback.date,
    abstract: text(".abstract-text") || labelled.get("摘要") || fallback.abstract,
    doi: normalizeDoi(labelled.get("DOI")) || fallback.doi,
    tags: tags.length ? tags : fallback.tags,
  });
}

/** EndNote tagged export supplies bibliographic fields absent from the search grid. */
export function parseCnkiEndnote(json: string, fallback: PaperCanonical): PaperCanonical {
  const result = JSON.parse(json) as { code?: number; data?: Array<{ key?: string; value?: string[] }> };
  const raw = result.data?.find((entry) => entry.key === "EndNote")?.value?.[0];
  if (result.code !== 1 || !raw) throw new Error("知网未返回 EndNote 元数据");
  const text = raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
  const fields = new Map<string, string[]>();
  let key = "";
  for (const line of text.split(/\r?\n/)) {
    const match = /^%([A-Z0-9@])\s+(.*)$/.exec(line);
    if (match) { key = match[1]!; fields.set(key, [...fields.get(key) ?? [], match[2]!.trim()]); }
    else if (key && line.trim()) { const list = fields.get(key)!; list[list.length - 1] += " " + line.trim(); }
  }
  const first = (key: string) => fields.get(key)?.[0];
  const authors = fields.get("A")?.filter(Boolean).map(creator);
  const tags = fields.get("K")?.flatMap((value) => value.split(/[;；]/)).map((value) => value.trim()).filter(Boolean);
  return cleanCanonical({ ...fallback,
    itemType: /thesis|学位/i.test(first("0") ?? "") ? "thesis" : fallback.itemType,
    title: first("T") || fallback.title, creators: authors?.length ? authors : fallback.creators,
    date: first("D") || fallback.date, journal: first("J") || fallback.journal,
    publisher: first("I") || fallback.publisher, volume: first("V") || fallback.volume,
    issue: first("N") || fallback.issue, pages: first("P") || fallback.pages,
    doi: normalizeDoi(first("R")) || fallback.doi,
    abstract: first("X") || fallback.abstract, tags: tags?.length ? tags : fallback.tags,
  });
}
