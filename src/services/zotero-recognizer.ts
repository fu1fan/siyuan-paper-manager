import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { assertPdfTextBudget, MAX_RECOGNIZER_WORDS } from "./resource-limits";

/** Zotero recognizer wire format. PDF.js run geometry approximates word bounds. */
export function recognizerPage(width: number, height: number, items: TextItem[], signal?: AbortSignal): unknown[] {
  assertPdfTextBudget(items, signal);
  const fonts = new Map<string, number>();
  let wordCount = 0;
  const lines: unknown[][] = [];
  let words: unknown[] = [];
  let previousY: number | undefined;
  for (const item of items) {
    signal?.throwIfAborted();
    const [a, b, , , x, y] = item.transform as number[];
    if (previousY !== undefined && Math.abs(previousY - y!) > 2 && words.length) { lines.push([words]); words = []; }
    previousY = y;
    if (!fonts.has(item.fontName)) fonts.set(item.fontName, fonts.size);
    const fontIndex = fonts.get(item.fontName)!;
    for (const match of item.str.matchAll(/\S+/g)) {
      if (++wordCount > MAX_RECOGNIZER_WORDS) throw new Error("PDF 单页识别词数超过 10000，已停止解析");
      const left = x! + item.width * match.index / Math.max(1, item.str.length);
      const right = left + item.width * match[0].length / Math.max(1, item.str.length);
      words.push([left, height - y! - item.height, right, height - y!, Math.hypot(a!, b!), 1, height - y!, 0, 0, 0, 0, 0, fontIndex, match[0]]);
    }
    if (item.hasEOL && words.length) { lines.push([words]); words = []; }
  }
  if (words.length) lines.push([words]);
  return [width, height, [[[[0, 0, 0, 0, lines]]]]];
}
