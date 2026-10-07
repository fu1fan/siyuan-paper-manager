import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { pdfTextLines, type PdfTextItem } from "../src/services/pdf-layout";
import { recognizerPage } from "../src/services/zotero-recognizer";
import { MAX_LOCAL_PDF_BYTES, MAX_PDF_TEXT_ITEMS, MAX_PDF_TEXT_CHARS, MAX_RECOGNIZER_WORDS, readLocalPdf } from "../src/services/resource-limits";

const item = (str: string, y = 700, size = 12): TextItem => ({
  str, transform: [size, 0, 0, size, 0, y], width: 100, height: size, fontName: "font", dir: "ltr", hasEOL: false,
});

it("rejects oversized local PDFs before reading or allocating their bytes", async () => {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
  await expect(readLocalPdf({ size: MAX_LOCAL_PDF_BYTES + 1, arrayBuffer })).rejects.toThrow("64 MiB");
  expect(arrayBuffer).not.toHaveBeenCalled();
  const buffer = new TextEncoder().encode("%PDF-1.4").buffer;
  expect(await readLocalPdf({ size: buffer.byteLength, arrayBuffer: async () => buffer })).toEqual(new Uint8Array(buffer));
});

it("enforces item and text budgets before grouping or building recognizer geometry", () => {
  const many = Array.from({ length: MAX_PDF_TEXT_ITEMS + 1 }, () => item("a"));
  const long = [item("a".repeat(MAX_PDF_TEXT_CHARS + 1))];
  for (const items of [many, long]) {
    expect(() => pdfTextLines(items)).toThrow("已停止解析");
    expect(() => recognizerPage(600, 800, items)).toThrow("已停止解析");
  }
  expect(() => recognizerPage(600, 800, [item("word ".repeat(MAX_RECOGNIZER_WORDS + 1))])).toThrow("识别词数");
});

it("keeps stable font indices and word geometry while avoiding repeated font scans", () => {
  const page = recognizerPage(600, 800, [item("first second"), { ...item("third"), fontName: "other" }, item("fourth")]) as any[];
  const words = page[2][0][0][0][4][0][0];
  expect(words.map((word: any[]) => [word[12], word[13]])).toEqual([[0, "first"], [0, "second"], [1, "third"], [0, "fourth"]]);
  expect(words[0].slice(0, 4)).toEqual([0, 88, 100 * 5 / 12, 100]);
});

it("does not linearly scan prior rows for thousands of different baselines", () => {
  const items = Array.from({ length: 5000 }, (_, index) => item("a", index * 4, 1));
  const abs = vi.spyOn(Math, "abs");
  try {
    expect(pdfTextLines(items)).toHaveLength(items.length);
    expect(abs.mock.calls.length).toBeLessThan(items.length * 2);
  } finally { abs.mockRestore(); }
});

it("preserves the first matching row for mixed sizes and irregular baselines", () => {
  const input = Array.from({ length: 200 }, (_, i) => item(String(i), 800 - ((i * 37) % 101), 1 + (i % 6) * 8));
  const reference: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const text of [...input].sort((a, b) => b.transform[5]! - a.transform[5]!)) {
    const y = text.transform[5]!;
    const found = reference.find(row => Math.abs(row.y - y) <= Math.max(1, text.height * 0.2));
    if (found) found.items.push(text);
    else reference.push({ y, items: [text] });
  }
  expect(pdfTextLines(input).map(row => [row.y, row.text]))
    .toEqual(reference.map(row => [row.y, row.items.map(text => text.str).join("")]));
});

it("honors cancellation before synchronous PDF expansion", () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => pdfTextLines([item("a")], controller.signal)).toThrow();
  expect(() => recognizerPage(600, 800, [item("a")], controller.signal)).toThrow();
});
