import { CnkiClient } from "../src/services/cnki-client";
import { resolve } from "node:path";
import { generateCitekey, uniqueCitekey } from "../src/core/naming";
import { splitChineseName } from "../src/core/chinese";
import { canonicalFromRaw } from "../src/core/normalize";
import { chineseLayoutTitle, pdfTextLines, type PdfLine } from "../src/services/pdf-layout";
import { inspectPdf, MetadataExtractor } from "../src/services/metadata-extractor";
import { pdfDocumentOptions } from "../src/services/pdf-runtime";
import { chinesePdf } from "./fixtures/chinese-pdf";
import { paper } from "./fixtures";

it("generates ASCII pinyin keys with surname readings, leaving source metadata intact", () => {
  const canonical = paper().canonical;
  const original = structuredClone(canonical);
  expect(generateCitekey(canonical)).toBe("shililunwen2026zhang");
  expect(canonical).toEqual(original);
  expect(generateCitekey({ ...canonical, creators: [{ family: "单伟", given: "", creatorType: "author" }] })).toMatch(/2026shan$/);
  expect(generateCitekey({ ...canonical, creators: [{ family: "欧阳明", given: "", creatorType: "author" }] })).toMatch(/2026ouyang$/);
  expect(generateCitekey({ ...canonical, title: "Deep Learning", creators: [{ family: "García", given: "A", creatorType: "author" }] })).toBe("deep2026garcia");
  expect(uniqueCitekey("zhang2026shililunwen", ["zhang2026shililunwen"])).toBe("zhang2026shililunwena");
});

it("handles compound surnames and preserves explicit creator fields", () => {
  expect(splitChineseName("欧阳明")).toEqual({ family: "欧阳", given: "明" });
  expect(splitChineseName("张 三")).toEqual({ family: "张", given: "三" });
  expect(splitChineseName("中国科学院研究所")).toBeUndefined();
  const canonical = canonicalFromRaw({ title: "研究", creators: [{ lastName: "欧阳明" }, { lastName: "张", firstName: "三" }, { name: "中国科学院研究所", fieldMode: 1 }] });
  expect(canonical.creators.map(({ family, given }) => ({ family, given }))).toEqual([
    { family: "欧阳", given: "明" }, { family: "张", given: "三" }, { family: "中国科学院研究所", given: "" },
  ]);
});

const line = (text: string, size: number, y: number): PdfLine => ({ text, size, y, x: 50 });
it("extracts multiline titles and skips CNKI advance-online covers", () => {
  const pages = [[line("《自动化学报》网络首发论文", 30, 800)], [
    line("自动化学报", 30, 810), line("基于深度学习的状态估计", 22, 750), line("及其控制应用", 22, 720),
    line("张三 李四", 12, 680), line("摘要：研究状态估计", 12, 640), line("正文内容", 12, 600),
  ]];
  expect(chineseLayoutTitle(pages)?.title).toBe("基于深度学习的状态估计及其控制应用");
  expect(chineseLayoutTitle([[line("硕士学位论文", 24, 800), line("论文题目：机器人控制方法研究", 20, 740)]]))
    .toEqual({ title: "机器人控制方法研究", thesis: true });
  expect(chineseLayoutTitle([[line("正文内容缺少标题线索", 12, 700), line("另一行普通正文", 12, 680)]])).toBeUndefined();
});

it("joins Chinese text runs without destroying Latin word boundaries", () => {
  const item = (str: string, x: number, width: number) => ({ str, transform: [20, 0, 0, 20, x, 700], width, height: 20 });
  expect(pdfTextLines([item("深 度", 0, 40), item("学习", 42, 40), item("Deep", 100, 40), item("Learning", 150, 70)])[0]?.text)
    .toBe("深度学习 Deep Learning");
});

it("parses a real Chinese PDF and extracts its title, authors and DOI", async () => {
  const bytes = chinesePdf();
  const original = bytes.slice();
  const snapshot = await inspectPdf(bytes);
  expect(snapshot.text).toContain("基于深度学习的状态估计方法");
  expect(bytes).toEqual(original);
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: {} }), { status: 404 }));
  // Isolate local extraction: DOI enrichment may fail without losing the parsed metadata.
  const result = await new MetadataExtractor({ fetchImpl }).extract(bytes, "download.pdf");
  expect(result.warnings.join(" ")).not.toMatch(/PDF 本地解析失败|workerSrc/);
  expect(result.selected.canonical.title).toBe("基于深度学习的状态估计方法及其在机器人控制中的应用");
  expect(result.selected.canonical.creators[0]).toMatchObject({ family: "欧阳", given: "明" });
  expect(result.selected.canonical.date).toBeUndefined();
  expect(result.detectedDoi).toBe("10.1234/example.2026");
  expect(result.selected.canonical.language).toBe("zh-CN");
});

it("sets browser worker and CJK asset URLs for the installed plugin", () => {
  vi.stubGlobal("location", new URL("http://127.0.0.1:6806/stage/build/desktop/"));
  try {
    expect(pdfDocumentOptions()).toMatchObject({
      cMapUrl: "http://127.0.0.1:6806/plugins/siyuan-paper-manager/pdfjs/cmaps/", cMapPacked: true,
    });
  } finally { vi.unstubAllGlobals(); }
});

it("extracts Chinese glyphs requiring the shipped Adobe CMap", async () => {
  const result = await inspectPdf(chinesePdf(true), { cMapUrl: `${resolve("node_modules/pdfjs-dist/cmaps").replaceAll("\\", "/")}/`, cMapPacked: true });
  expect(result.text).toContain("基于深度学习的状态估计方法");
});

it("keeps local candidates usable when optional CNKI fetch fails", async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    if (String(input).startsWith("https://kns.cnki.net/")) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ message: {} }), { status: 404 });
  });
  const result = await new MetadataExtractor({ enableCnki: true, fetchImpl, cnkiClient: new CnkiClient({ verify: async () => {}, request: async () => { throw new TypeError("Failed to fetch"); } }) }).extract(chinesePdf(), "download.pdf");
  expect(result.selected.canonical.title).toContain("基于深度学习");
  expect(result.selected.canonical.creators[0]).toMatchObject({ family: "欧阳", given: "明" });
  expect(result.warnings).toContainEqual(expect.stringMatching(/知网在线补充检索未完成.*Failed to fetch.*已有候选仍可使用/));
});
