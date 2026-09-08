import { normalizePdfText, type PdfLine } from "./pdf-layout";

/** Read labelled front matter; never infer publication dates from PDF creation time. */
export function extractChineseThesis(pages: PdfLine[][]) {
  const lines = pages.flatMap((page) => page.map((line) => normalizePdfText(line.text)));
  const cover = pages.slice(0, 3).flatMap((page) => page.map((line) => normalizePdfText(line.text))).join("\n");
  const isThesis = /(?:硕士|博士)(?:学位)?论文/.test(cover);
  if (!isThesis) return { isThesis, tags: [] as string[] };
  const author = cover.match(/(?:作者姓名|作者|学位申请人|研究生姓名)\s*[:：]\s*([\p{Unified_Ideograph}]{2,4}?)(?=学号|\s|$)/mu)?.[1];
  const publisher = lines.map((line) => line.match(/^([\p{Unified_Ideograph}]{2,16}(?:大学|学院))(?=(?:硕士|博士)|$)/u)?.[1]).find(Boolean);
  const dateMatch = cover.match(/(20\d{2}|19\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/);
  const date = dateMatch ? [dateMatch[1], dateMatch[2]!.padStart(2, "0"), ...(dateMatch[3] ? [dateMatch[3].padStart(2, "0")] : [])].join("-") : undefined;
  const start = lines.findIndex((line) => /^摘\s*要\s*[:：]?$/.test(line));
  const tail = start >= 0 ? lines.slice(start + 1) : [];
  const end = tail.findIndex((line) => /^(?:关键词|关键字|Abstract\b|ABSTRACT\b)/.test(line));
  const useful = (line: string) => !/^(?:[IVXivx\d]+|万方数据|.*(?:大学|学院)(?:硕士|博士)(?:学位)?论文)$/.test(line);
  const abstract = end >= 0 ? tail.slice(0, end).filter(useful).join("").replace(/^(?:摘要\s*[:：]?)+/, "") : undefined;
  const keywordLine = tail[end] ?? "";
  let keywords = keywordLine.replace(/^(?:关键词|关键字)\s*[:：]?\s*/, "");
  if (/^(?:关键词|关键字)/.test(keywordLine)) {
    for (const line of tail.slice(end + 1, end + 4)) {
      if (!useful(line) || /^(?:分类号|中图|Abstract|ABSTRACT|Key\s*words)/i.test(line) || line.length > 80) break;
      keywords += line;
    }
  } else keywords = "";
  return { isThesis, author, publisher, date, abstract, tags: keywords.split(/[;；、]/).map((tag) => tag.trim()).filter(Boolean) };
}
