import type { TextItem } from "pdfjs-dist/types/src/display/api";

/** Zotero recognizer wire format. PDF.js run geometry approximates word bounds. */
export function recognizerPage(width: number, height: number, items: TextItem[]): unknown[] {
  const fonts: string[] = [];
  const lines: unknown[][] = [];
  let words: unknown[] = [];
  let previousY: number | undefined;
  for (const item of items) {
    const [a, b, , , x, y] = item.transform as number[];
    if (previousY !== undefined && Math.abs(previousY - y!) > 2 && words.length) { lines.push([words]); words = []; }
    previousY = y;
    if (!fonts.includes(item.fontName)) fonts.push(item.fontName);
    for (const match of item.str.matchAll(/\S+/g)) {
      const left = x! + item.width * match.index / Math.max(1, item.str.length);
      const right = left + item.width * match[0].length / Math.max(1, item.str.length);
      words.push([left, height - y! - item.height, right, height - y!, Math.hypot(a!, b!), 1, height - y!, 0, 0, 0, 0, 0, fonts.indexOf(item.fontName), match[0]]);
    }
    if (item.hasEOL && words.length) { lines.push([words]); words = []; }
  }
  if (words.length) lines.push([words]);
  return [width, height, [[[[0, 0, 0, 0, lines]]]]];
}
