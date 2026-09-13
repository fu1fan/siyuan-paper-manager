import { MetadataExtractor } from '../src/services/metadata-extractor';
import { arxivClient } from '../src/services/arxiv-client';

const fixture = vi.hoisted(() => ({ text: 'arXiv:2302.11665v2', doi: '' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
    getMetadata: async () => ({ info: { Title: 'Example research paper', DOI: fixture.doi }, metadata: null }),
    getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), cleanup() {},
      getTextContent: async () => ({ items: [{ str: fixture.text, transform: [12, 0, 0, 12, 50, 700], width: 250, height: 12, fontName: 'Test' }] }) }),
  }), destroy: async () => {} }),
}));
afterEach(() => { vi.restoreAllMocks(); fixture.text = 'arXiv:2302.11665v2'; fixture.doi = ''; });

it('does not repeat failed arXiv/Citoid requests when Zotero returns the same identifier without a version', async () => {
  const arxiv = vi.spyOn(arxivClient, 'query').mockRejectedValue(new Error('arXiv 请求频率受限'));
  const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('recognizer')
    ? Response.json({ title: 'Example research paper', arxiv: '2302.11665' })
    : new Response('', { status: 503 }));
  const stages: string[] = [];
  const result = await new MetadataExtractor({ fetchImpl, enableZoteroRecognizer: true, onProgress: text => stages.push(text) }).extract(new Uint8Array(), 'example.pdf');
  expect(arxiv).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('data/citation'))).toHaveLength(1);
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('query.title'))).toBe(false);
  expect(result.warnings).toHaveLength(2);
  expect(stages.some(s => s.includes('第 1/1 页'))).toBe(true);
  expect(stages.some(s => s.includes('Citoid API（www.mediawiki.org）'))).toBe(true);
  expect(stages.some(s => s.includes('Zotero Recognizer API'))).toBe(true);
});

it('uses precise DOI success without invoking optional recognizer or title search', async () => {
  fixture.text = 'DOI:10.1234/example'; fixture.doi = '10.1234/example';
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message: { title: ['Example research paper'], DOI: fixture.doi } }));
  const result = await new MetadataExtractor({ fetchImpl, enableZoteroRecognizer: true }).extract(new Uint8Array(), 'example.pdf');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(String(fetchImpl.mock.calls[0]![0])).toContain('/works/10.1234%2Fexample');
  expect(result.candidates.some(c => c.provider === 'crossref')).toBe(true);
});

it('routes arXiv DOIs to arXiv instead of Crossref', async () => {
  const arxiv = vi.spyOn(arxivClient, 'query').mockResolvedValue('<entry><id>http://arxiv.org/abs/2302.11665v2</id><title>Example</title></entry>');
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await new MetadataExtractor({ fetchImpl }).lookup('10.48550/arXiv.2302.11665');
  expect(result.selected.provider).toBe('arxiv'); expect(arxiv).toHaveBeenCalledTimes(1); expect(fetchImpl).not.toHaveBeenCalled();
});

it('uses the verified Wikimedia Citoid endpoint and does not retry rate limits', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
  await expect(new MetadataExtractor({ fetchImpl }).lookup('PMID: 12345')).rejects.toThrow('HTTP 429');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(String(fetchImpl.mock.calls[0]![0])).toContain('https://www.mediawiki.org/api/rest_v1/data/citation/zotero/');
});

it('keeps a fresh request scope for explicit retries', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([{ title: 'Example', creators: [] }]));
  const extractor = new MetadataExtractor({ fetchImpl });
  await extractor.lookup('PMID: 12345'); await extractor.lookup('PMID: 12345');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('does not retry a failed DOI/Citoid pair after recognizer rediscovers that DOI', async () => {
  fixture.text = 'DOI:10.1234/example';
  const fetchImpl = vi.fn<typeof fetch>(async input => String(input).includes('recognizer')
    ? Response.json({ title: 'Example research paper', doi: 'https://doi.org/10.1234/example' })
    : new Response('', { status: 404 }));
  const result = await new MetadataExtractor({ fetchImpl, enableZoteroRecognizer: true }).extract(new Uint8Array(), 'example.pdf');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(result.warnings).toHaveLength(2);
});

it('keeps the timeout active while reading a response body', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); },
  })));
  await expect(new MetadataExtractor({ fetchImpl, timeoutMs: 10 }).lookup('PMID: 12345')).rejects.toThrow('请求超时');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('propagates user cancellation without starting another provider', async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>(async () => { controller.abort(); throw controller.signal.reason; });
  await expect(new MetadataExtractor({ fetchImpl, signal: controller.signal }).lookup('10.1234/example')).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('returns the enriched recommendation once rather than alongside the original API candidate', async () => {
  fixture.text = 'DOI:10.1234/example';
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message: { title: ['Example research paper'], DOI: '10.1234/example' } }));
  const result = await new MetadataExtractor({ fetchImpl }).extract(new Uint8Array(), 'example.pdf');
  expect(result.candidates).toContain(result.selected);
  expect(result.candidates.filter(c => c.provider === result.selected.provider && c.canonical.title === result.selected.canonical.title)).toHaveLength(1);
});
