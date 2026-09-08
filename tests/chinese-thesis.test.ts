import zhou from "./fixtures/zhou-thesis-layout.json";
import zhang from "./fixtures/zhang-thesis-layout.json";
import { localCandidate, MetadataExtractor } from "../src/services/metadata-extractor";
import { extractChineseThesis } from "../src/services/chinese-thesis";
import { chinesePdf } from "./fixtures/chinese-pdf";

it.each([
  [zhou, "双有源全桥双向DC-DC变换器典型拓扑研究_周路遥.pdf", "周", "路遥", "北京交通大学", "2016-03", 7],
  [zhang, "双有源桥DC-DC变换器多目标优化控制研究_张天晖.pdf", "张", "天晖", "华中科技大学", "2019-05-22", 5],
] as const)("extracts labelled metadata from supplied thesis layouts", (snapshot, filename, family, given, publisher, date, keywords) => {
  const c = localCandidate(snapshot, filename).canonical;
  expect(c).toMatchObject({ itemType: "thesis", creators: [{ family, given, creatorType: "author" }], publisher, date, language: "zh-CN" });
  expect(c.title).toBe(filename.includes("周") ? filename.split("_")[0] : "双有源桥DC/DC变换器多目标优化控制研究");
  expect(c.tags).toHaveLength(keywords);
  expect(c.abstract!.length).toBeGreaterThan(200);
  expect(c.abstract).not.toMatch(/万方数据|学位论文|^摘要/);
});

it("does not use CNKI authors or creation dates, or parse journal body as thesis metadata", () => {
  expect(localCandidate({ info: { Author: "CNKI", CreationDate: "D:20230101" }, xmp: {}, text: "" }, "文献.pdf").canonical)
    .toMatchObject({ creators: [] });
  expect(extractChineseThesis([[{ text: "作者：张三 2019年5月", x: 0, y: 0, size: 12 }]]).author).toBeUndefined();
});

it("uses valid Crossref title fields and retains local creators when enrichment is empty", async () => {
  // Remove DOI without changing byte offsets in the valid fixture.
  const bytes = chinesePdf();
  const content = Buffer.from(bytes).toString().replaceAll(Buffer.from("10.1234", "utf16le").swap16().toString("hex").toUpperCase(), Buffer.from("XX.XXXX", "utf16le").swap16().toString("hex").toUpperCase());
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("query.title")).toContain("基于深度学习");
    expect(url.searchParams.get("select")!.split(",")).not.toContain("language");
    return new Response(JSON.stringify({ message: { items: [{ title: [url.searchParams.get("query.title")], DOI: "10.1/test" }] } }));
  });
  const result = await new MetadataExtractor({ fetchImpl }).extract(new Uint8Array(Buffer.from(content)), "test.pdf");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.selected.canonical.creators[0]?.family).toBe("欧阳");
});

it("does not retry permanent HTTP errors", async () => {
  const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
  const result = await new MetadataExtractor({ fetchImpl }).extract(chinesePdf(), "test.pdf");
  expect(fetchImpl).toHaveBeenCalledTimes(2); // one Crossref DOI request and one Citoid fallback
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.every((warning) => warning.includes("HTTP 400"))).toBe(true);
});
