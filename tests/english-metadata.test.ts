import { arxivCandidate, findArxiv, mergeMetadata, localCandidate, MetadataExtractor } from "../src/services/metadata-extractor";
import { englishPdfMetadata } from "../src/services/english-pdf";
import type { PdfLine } from "../src/services/pdf-layout";
const line = (text: string, size: number, y: number): PdfLine => ({ text, size, y, x: 50 });
const pages = [[line("AlpaServe: Statistical Multiplexing with Model Parallelism", 14, 750), line("for Deep Learning Serving", 14, 732),
  line("Zhuohan Li", 12, 710), line("UC Berkeley", 12, 690), line("Abstract", 10, 660),
  line("Model parallelism is conventionally viewed as a method to scale a single model.", 10, 644), line("1 Introduction", 10, 620)]];
it("recovers an English title and author without XMP, preserving local metadata offline", () => {
  const candidate = localCandidate({ info: {}, xmp: {}, text: "", pages }, "unhelpful.pdf");
  expect(candidate.provider).toBe("pdf-text");
  expect(candidate.canonical.title).toBe("AlpaServe: Statistical Multiplexing with Model Parallelism for Deep Learning Serving");
  expect(candidate.canonical.creators).toEqual([{ family: "Li", given: "Zhuohan", creatorType: "author" }]);
  expect(candidate.canonical.abstract).not.toContain("Introduction");
  expect(englishPdfMetadata([[line("Ordinary body text without any title or other identifying information", 10, 600)]])).toBeUndefined();
});
it("detects explicit modern and legacy arXiv identifiers without treating references as arbitrary ids", () => {
  expect(findArxiv("arXiv:2302.11665v2 [cs.LG]")).toBe("2302.11665v2");
  expect(findArxiv("https://arxiv.org/pdf/hep-th/9901001.pdf")).toBe("hep-th/9901001");
  expect(findArxiv("an unrelated 2302.11665 number")).toBeUndefined();
});
it("parses arXiv Atom authors and publication date, rejecting error entries", () => {
  const result = arxivCandidate('<feed><entry><id>http://arxiv.org/abs/2302.11665v2</id><title>AlpaServe</title><author><name>Zhuohan Li</name></author><published>2023-02-22T00:00:00Z</published><summary>Serving models.</summary></entry></feed>');
  expect(result?.canonical.creators[0]?.family).toBe("Li");
  expect(result?.canonical.date).toBe("2023-02-22");
  expect(result?.canonical.doi).toBe("10.48550/arxiv.2302.11665");
  expect(result?.canonical.url).toBe("https://arxiv.org/abs/2302.11665v2");
  expect(arxivCandidate('<entry><title>Error</title><id>http://arxiv.org/api/errors</id></entry>')).toBeUndefined();
});
it("preserves a published DOI and supplies arXiv DOIs for legacy identifiers", () => {
  const entry = '<entry><id>http://arxiv.org/abs/hep-th/9901001v3</id><title>Legacy paper</title></entry>';
  expect(arxivCandidate(entry)?.canonical.doi).toBe("10.48550/arxiv.hep-th/9901001");
  const published = entry.replace('</entry>', '<arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/published</arxiv:doi></entry>');
  expect(arxivCandidate(published)?.canonical.doi).toBe("10.1000/published");
});
it("uses exact DOI then Citoid fallback, and parses BibTeX without network", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json([{title:'Example', creators:[]} ]));
  const extractor = new MetadataExtractor({ fetchImpl });
  expect((await extractor.lookup('https://doi.org/10.1234/example')).selected.provider).toBe('citoid');
  expect(fetchImpl.mock.calls[1]?.[0]).toContain('data/citation/zotero/');
  const parsed = await extractor.lookup('@article{key,title={A {Nested} Title},author={Li, Zhuohan and Zheng, Lianmin},year={2023},doi={10.1234/test}}');
  expect(parsed.selected.canonical.creators).toHaveLength(2);
  expect(parsed.selected.canonical.date).toBe('2023');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("propagates cancellation and rejects empty lookup responses", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(new MetadataExtractor({ signal: controller.signal }).lookup('10.1234/test')).rejects.toThrow();
  await expect(new MetadataExtractor({ fetchImpl: vi.fn().mockResolvedValue(Response.json([])) }).lookup('https://example.org/paper')).rejects.toThrow('没有找到');
});
it("maps PubMed identifiers to explicit URLs", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ title: 'Paper' }]));
  await new MetadataExtractor({ fetchImpl }).lookup('PMID: 12345');
  expect(decodeURIComponent(String(fetchImpl.mock.calls[0]?.[0]))).toContain('https://pubmed.ncbi.nlm.nih.gov/12345/');
});

it("does not truncate a complete local author list with a recognizer prefix", () => {
  const local = localCandidate({ info: {}, xmp: {}, text: "", pages }, "test.pdf");
  local.canonical.creators.push({ family: "Stoica", given: "Ion", creatorType: "author" });
  const remote = { ...local, provider: "zotero" as const, canonical: { ...local.canonical, creators: local.canonical.creators.slice(0, 1) } };
  expect(mergeMetadata(local, remote).canonical.creators).toHaveLength(2);
});
