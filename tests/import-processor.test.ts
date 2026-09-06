import { ATTR, SOURCE } from "../src/constants";
import { generateCitekey } from "../src/core/naming";
import { sha256 } from "../src/core/env";
import type { KernelClient } from "../src/core/kernel";
import type { TemplateService } from "../src/core/templates";
import { ItemProcessor } from "../src/services/item-processor";
import type { DuplicateResolver } from "../src/services/item-processor";
import type { LibraryService, LibraryPaperRecord } from "../src/services/library-service";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import type { ImportCandidate } from "../src/types/import";
import { paper } from "./fixtures";

function setup(records: LibraryPaperRecord[], resolver: DuplicateResolver = vi.fn(async () => ({ action: "merge" as const, overwrite: [] }))) {
  const library = { docId: "library-doc", hPath: "/库", notebookId: "box" };
  const kernel = {
    createDocument: vi.fn(async () => ({ id: `new-${records.length}` })),
    setBlockAttrs: vi.fn(), uploadAsset: vi.fn(async () => "assets/new.pdf"),
  };
  const libraries = {
    getLibrary: vi.fn(async () => library),
    listPapersAndCitekeys: vi.fn(async () => ({ papers: [...records], citekeys: records.map((r) => r.paper.citekey) })),
    readPaper: vi.fn(async () => paper()),
    syncPaper: vi.fn(async (docId: string, data: ReturnType<typeof paper>) => {
      if (!records.some((r) => r.docId === docId)) records.push({ docId, paper: data, projectIds: [] });
      return "item";
    }),
  };
  const templates = { ensureSections: vi.fn(async () => ({ meta: "meta", note: "note" })), refreshMeta: vi.fn() };
  const processor = new ItemProcessor(kernel as unknown as KernelClient, templates as unknown as TemplateService,
    () => ({ ...DEFAULT_SETTINGS, defaultLibraryDocId: "library-doc" }), resolver, libraries as unknown as LibraryService);
  return { processor, kernel, libraries, resolver };
}

function candidate(): ImportCandidate {
  return { id: "incoming", source: SOURCE.pdf, canonical: { ...paper().canonical, doi: undefined }, raw: {}, attachments: [] };
}

it("detects a duplicate without DOI before assigning a citekey suffix", async () => {
  const incoming = candidate();
  const existing = paper({ canonical: incoming.canonical, citekey: generateCitekey(incoming.canonical) });
  const { processor, resolver, kernel } = setup([{ docId: "existing", paper: existing, projectIds: [] }]);
  expect((await processor.process(incoming)).action).toBe("merged");
  expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ reason: "citekey-title" }), expect.anything());
  expect(kernel.createDocument).not.toHaveBeenCalled();
});

it("preserves old attachments and translations and avoids uploading an identical attachment on merge", async () => {
  const incoming = candidate();
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  incoming.attachments = [{ title: "same.pdf", mimeType: "application/pdf", bytes }];
  const existing = paper({
    canonical: incoming.canonical, citekey: generateCitekey(incoming.canonical),
    attachments: [{ title: "original", mimeType: "application/pdf", assetAddress: "assets/old.pdf", sha256: await sha256(bytes) }],
    translation: { mono: "assets/old-mono.pdf", dual: "assets/old-dual.pdf" },
  });
  const { processor, libraries, kernel } = setup([{ docId: "existing", paper: { ...existing, attachments: [], translation: {} }, projectIds: [] }]);
  libraries.readPaper.mockResolvedValue(existing);
  await processor.process(incoming);
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
  expect(kernel.setBlockAttrs).toHaveBeenCalledWith("existing", expect.objectContaining({
    [ATTR.attachments]: JSON.stringify(existing.attachments),
    [ATTR.translationMono]: "assets/old-mono.pdf", [ATTR.translationDual]: "assets/old-dual.pdf",
  }));
});

it("serializes simultaneous imports so the second sees the first paper", async () => {
  const { processor, kernel, resolver } = setup([]);
  const results = await Promise.all([processor.process(candidate()), processor.process(candidate())]);
  expect(results.map((r) => r.action)).toEqual(["created", "merged"]);
  expect(kernel.createDocument).toHaveBeenCalledTimes(1);
  expect(resolver).toHaveBeenCalledTimes(1);
});

it("keeps the import queue usable after a failure", async () => {
  const { processor, libraries } = setup([]);
  libraries.getLibrary.mockRejectedValueOnce(new Error("offline"));
  const failed = processor.process(candidate());
  const next = processor.process(candidate());
  await expect(failed).rejects.toThrow("offline");
  expect((await next).action).toBe("created");
});
