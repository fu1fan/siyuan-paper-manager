import { containsHan } from "../core/chinese";

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  size: number;
  segments?: Array<{ text: string; x: number; width: number }>;
}
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export function normalizePdfText(value: string): string {
  return value.normalize("NFKC")
    .replace(/\p{Private_Use}/gu, "")
    .replace(/(?<=\p{Unified_Ideograph})\s+(?=\p{Unified_Ideograph})/gu, "")
    .replace(/\s+/g, " ").trim();
}

/** Assemble a line from positioned text runs before applying Chinese title heuristics. */
export function pdfTextLines(items: PdfTextItem[]): PdfLine[] {
  const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of items.filter((item) => item.str.trim()).sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!)) {
    const y = item.transform[5] ?? 0;
    const size = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 1;
    const row = rows.find((row) => Math.abs(row.y - y) <= Math.max(1, size * 0.2));
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows.map((row) => {
    const items = row.items.sort((a, b) => a.transform[4]! - b.transform[4]!);
    let text = "";
    const segments: Array<{ text: string; x: number; width: number }> = [];
    for (const [index, item] of items.entries()) {
      const previous = items[index - 1];
      const gap = previous ? item.transform[4]! - (previous.transform[4]! + previous.width) : 0;
      text += `${gap > 1 ? " " : ""}${item.str}`;
      const last = segments.at(-1);
      const size = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 1;
      if (!last || gap > size * 0.8) segments.push({ text: item.str, x: item.transform[4] ?? 0, width: item.width });
      else { last.text += `${gap > 1 ? " " : ""}${item.str}`; last.width = (item.transform[4] ?? 0) + item.width - last.x; }
    }
    const hanItems = items.filter((item) => containsHan(item.str));
    return {
      segments: segments.map((segment) => ({ ...segment, text: normalizePdfText(segment.text) })),
      text: normalizePdfText(text), x: items[0]?.transform[4] ?? 0, y: row.y,
      size: Math.max(...(hanItems.length ? hanItems : items)
        .map((item) => Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 1)),
    };
  });
}

/** Independently implemented layout heuristics, informed by Jasminum's PDF title workflow. */
export function chineseLayoutTitle(pages: PdfLine[][]): { title: string; thesis: boolean } | undefined {
  const thesis = pages.some((lines) => lines.some((line) => /(?:硕士|博士|学位|毕业)论文/.test(line.text)));
  const pageIndex = pages[0]?.some((line) => /网络首发论文/.test(line.text)) ? 1 : 0;
  const lines = (pages[pageIndex] ?? []).slice(0, 60);
  const end = lines.findIndex((line) => /^(?:摘要|关键词|Abstract\b|参考文献)/i.test(line.text));
  const front = end >= 0 ? lines.slice(0, end) : lines;
  const valid = (line: PdfLine) => containsHan(line.text) && line.text.length >= 5 && line.text.length <= 150
    && !/^(?:摘要|关键词|作者|研究生|指导教师|导师|学校代码|学号|分类号|密级|DOI\b|doi\b|第\s*\d+\s*[卷期])/.test(line.text)
    && !/(?:大学|学院|学报|杂志|学位论文|毕业论文|硕士论文|博士论文|网络首发|收稿日期|基金项目|版权所有|学术不端)$/.test(line.text)
    && !/(?:ISSN|CN\s*\d{2}-|https?:\/\/)/i.test(line.text);
  const explicit = front.find((line) => /^(?:论文)?题目\s*[:：]/.test(line.text));
  if (explicit) {
    const title = explicit.text.replace(/^(?:论文)?题目\s*[:：]\s*/, "");
    if (valid({ ...explicit, text: title })) return { title, thesis };
  }
  const candidates = front.filter(valid);
  const ranked = [...candidates].sort((a, b) => b.size - a.size || b.y - a.y);
  const best = ranked[0];
  if (!best) return undefined;
  const sizes = [...lines].map((line) => line.size).sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2);
  const median = sizes.length % 2 ? sizes[middle]! : ((sizes[middle - 1] ?? best.size) + (sizes[middle] ?? best.size)) / 2;
  if (best.size < median * 1.15) return undefined;
  let title = best.text;
  const index = front.indexOf(best);
  for (const next of front.slice(index + 1, index + 3)) {
    if (!valid(next) || Math.abs(next.size - best.size) > best.size * 0.1 || Math.abs(next.y - best.y) > best.size * 3) break;
    title += next.text;
  }
  return { title: title.replace(/[\s*＊①②③④⑤]+$/u, ""), thesis };
}
