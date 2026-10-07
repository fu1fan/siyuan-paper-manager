import { inspectPdf, MetadataExtractor } from "../src/services/metadata-extractor";
import { MAX_LOCAL_PDF_BYTES, MAX_PDF_TEXT_ITEMS } from "../src/services/resource-limits";

const fixture = vi.hoisted(() => ({
  items: [{ str: "Example text", transform: [12, 0, 0, 12, 50, 700], width: 250, height: 12, fontName: "Test" }],
  getViewport: vi.fn(() => ({ width: 600, height: 800 })), destroy: vi.fn(async () => {}), getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => {
    fixture.getDocument(...args);
    return { promise: Promise.resolve({ numPages: 1,
      getMetadata: async () => ({ info: {}, metadata: null }),
      getPage: async () => ({ getViewport: fixture.getViewport, cleanup() {}, getTextContent: async () => ({ items: fixture.items }) }),
    }), destroy: fixture.destroy };
  },
}));
afterEach(() => { vi.clearAllMocks(); });

it("does not construct recognizer geometry by default or when online recognition is disabled", async () => {
  expect((await inspectPdf(new Uint8Array())).recognizer).toBeUndefined();
  const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
  await new MetadataExtractor({ enableZoteroRecognizer: false, fetchImpl }).extract(new Uint8Array(), "example.pdf");
  expect(fixture.getViewport).not.toHaveBeenCalled();
});

it("still builds recognizer geometry when explicitly enabled", async () => {
  const snapshot = await inspectPdf(new Uint8Array(), undefined, undefined, undefined, true);
  expect(snapshot.recognizer?.pages).toHaveLength(1);
  expect(fixture.getViewport).toHaveBeenCalledOnce();
});

it("rejects oversized PDF buffers before copying or passing them to PDF.js", async () => {
  const bytes = new Uint8Array(MAX_LOCAL_PDF_BYTES + 1);
  const slice = vi.spyOn(bytes, "slice");
  await expect(inspectPdf(bytes)).rejects.toThrow("64 MiB");
  await expect(new MetadataExtractor().extract(bytes, "large.pdf")).rejects.toThrow("64 MiB");
  expect(slice).not.toHaveBeenCalled();
  expect(fixture.getDocument).not.toHaveBeenCalled();
});

it("destroys the PDF worker after a page exceeds the processing budget", async () => {
  const original = fixture.items;
  fixture.items = Array.from({ length: MAX_PDF_TEXT_ITEMS + 1 }, () => original[0]!);
  try {
    await expect(inspectPdf(new Uint8Array())).rejects.toThrow("文字项");
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(fixture.getViewport).not.toHaveBeenCalled();
  } finally { fixture.items = original; }
});
