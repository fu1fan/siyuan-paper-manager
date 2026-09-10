import type { PaperCreator } from "../types/paper";
import type { PdfLine } from "./pdf-layout";

/** Conservative first-page typography fallback for PDFs with empty XMP fields. */
export function englishPdfMetadata(pages: PdfLine[][]): { title: string; creators: PaperCreator[]; abstract?: string } | undefined {
  const lines = pages[0] ?? [];
  const abstractIndex = lines.findIndex((line) => /^Abstract\b/i.test(line.text));
  const front = lines.slice(0, abstractIndex >= 0 ? abstractIndex : 30);
  const eligible = (line: PdfLine) => /[A-Za-z]{3}/.test(line.text) && !/[\u3400-\u9fff]/.test(line.text)
    && line.text.length >= 12 && line.text.length < 220
    && !/arxiv|https?:|@|copyright|proceedings|conference on|university|institute|\bissn\b/i.test(line.text);
  const best = front.filter(eligible).sort((a, b) => b.size - a.size || b.y - a.y)[0];
  if (!best) return undefined;
  const bodySizes = (abstractIndex >= 0 ? lines.slice(abstractIndex + 1) : lines).filter((line) => line.text.length > 50 && /[a-z]/.test(line.text)).map((line) => line.size).sort((a, b) => a - b);
  const median = bodySizes[Math.floor(bodySizes.length / 2)];
  if (!median || best.size < median * 1.15) return undefined;
  const titleLines = [best];
  let end = front.indexOf(best);
  for (const line of front.slice(end + 1, end + 4)) {
    const previous = titleLines.at(-1)!;
    if (!eligible(line) || Math.abs(line.size - best.size) > best.size * 0.08 || previous.y - line.y > best.size * 2) break;
    titleLines.push(line); end++;
  }
  const title = titleLines.map((line) => line.text).join(" ").replace(/\s+/g, " ").trim();
  const creators: PaperCreator[] = [];
  for (const line of front.slice(end + 1)) {
    if (/(?:university|institute|laborator|department|school|berkeley|google|microsoft|@)/i.test(line.text)) break;
    if (line.size < best.size * 0.65 || !/[A-Za-z]/.test(line.text)) continue;
    const names = (line.segments?.map((segment) => segment.text) ?? [line.text]).flatMap((text) => text.split(/\s*[,;]\s*|\s+and\s+/));
    for (const name of names) {
      const clean = name.replace(/[\d*†‡∗]+/g, "").trim();
      if (!/^(?:[A-Z][\p{L}.'’-]*\s+){1,4}[A-Z][\p{L}'’-]+$/u.test(clean)) continue;
      const parts = clean.split(/\s+/);
      creators.push({ family: parts.pop()!, given: parts.join(" "), creatorType: "author" });
    }
  }
  let abstract: string | undefined;
  if (abstractIndex >= 0) {
    const segments = lines.flatMap((line) => line.segments ?? []);
    const min = Math.min(...segments.map((segment) => segment.x));
    const max = Math.max(...segments.map((segment) => segment.x + segment.width));
    const middle = (min + max) / 2;
    const heading = lines[abstractIndex]!;
    const leftColumn = (heading.segments?.find((segment) => /^Abstract\b/i.test(segment.text))?.x ?? heading.x) < middle;
    const parts: string[] = [];
    for (const line of lines.slice(abstractIndex + 1)) {
      const text = line.segments?.filter((segment) => leftColumn ? segment.x < middle : segment.x >= middle).map((segment) => segment.text).join(" ") ?? line.text;
      if (/^(?:\d+\s+)?(?:Introduction|Keywords|Index Terms|CCS Concepts)\b/i.test(text)) break;
      if (!text || line.size < median * 0.85 || /^(?:arXiv:|https?:|\d+$)/i.test(text)) continue;
      parts.push(text);
      if (parts.join(" ").length > 3500) break;
    }
    abstract = parts.join(" ").replace(/(\p{L})-\s+(\p{Ll})/gu, "$1$2") || undefined;
  }
  return { title, creators, abstract };
}
