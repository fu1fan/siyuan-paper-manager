import { readFileSync } from "node:fs";
import { inspectPdf, localCandidate, MetadataExtractor } from "../src/services/metadata-extractor";

// Local, opt-in regression: never uploads the supplied PDF or requires a network.
const path = process.env.PAPER_MANAGER_TEST_USENIX_PDF;
it.skipIf(!path)("recovers AlpaServe metadata from its USENIX cover and article page offline", async () => {
  const bytes = new Uint8Array(readFileSync(path!));
  const snapshot = await inspectPdf(bytes);
  const local = localCandidate(snapshot, "osdi23ndanon-paper.pdf").canonical;
  expect(local.title).toBe("AlpaServe: Statistical Multiplexing with Model Parallelism for Deep Learning Serving");
  expect(local.creators).toHaveLength(11);
  expect(local.creators[10]).toMatchObject({ given: "Ion", family: "Stoica" });
  expect(local.itemType).toBe("conferencePaper");
  expect(local.date).toBe("2023");
  expect(local.journal).toBe("17th USENIX Symposium on Operating Systems Design and Implementation");
  expect(local.isbn).toBe("978-1-939133-34-2");
  expect(local.url).toBe("https://www.usenix.org/conference/osdi23/presentation/li-zhuohan");
  expect(local.abstract).toContain("Model parallelism is conventionally viewed");
  expect(local.abstract).not.toContain("Introduction");
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: { items: [] } }));
  const result = await new MetadataExtractor({ fetchImpl }).extract(bytes, "osdi23ndanon-paper.pdf");
  expect(result.selected.canonical).toEqual(local);
  expect(result.warnings).toContain("Crossref 标题检索未找到足够相似的结果；已保留 PDF 本地元数据");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
