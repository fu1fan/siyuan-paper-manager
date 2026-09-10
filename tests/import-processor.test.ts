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
    renameDocument: vi.fn(),
    createDocument: vi.fn(async () => ({ id: `new-${records.length}` })),
    setBlockAttrs: vi.fn(), uploadAsset: vi.fn(async () => "assets/new.pdf"),
  };
  const libraries = {
    citekeys: vi.fn(async () => [] as string[]),
    getLibrary: vi.fn(async () => library),
    listPapersAndCitekeys: vi.fn(async () => ({ papers: [...records], citekeys: records.map((r) => r.paper.citekey) })),
    readPaper: vi.fn(async () => paper()),
    syncPaper: vi.fn(async (docId: string, data: ReturnType<typeof paper>) => {
      if (!records.some((r) => r.docId === docId)) records.push({ docId, paper: data, projectNames: [] });
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
  const { processor, resolver, kernel } = setup([{ docId: "existing", paper: existing, projectNames: [] }]);
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
  const { processor, libraries, kernel } = setup([{ docId: "existing", paper: { ...existing, attachments: [], translation: {} }, projectNames: [] }]);
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


it("adds late files to the existing paper while preserving edits and translations made during upload", async () => {
  const { processor, libraries, kernel, resolver } = setup([]);
  const before = paper({ canonical: { ...paper().canonical, title: "Before" } });
  const latest = paper({
    canonical: { ...before.canonical, title: "User edited" },
    attachments: [{ title: "Existing", mimeType: "text/html", assetAddress: "assets/old.html", sha256: "old" }],
    translation: { mono: "assets/new-mono.pdf" },
  });
  libraries.readPaper.mockResolvedValueOnce(before).mockResolvedValueOnce(latest);
  await processor.addAttachments("existing-doc", [{ title: "Full Text PDF", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70, 45]) }]);
  expect(kernel.createDocument).not.toHaveBeenCalled();
  expect(resolver).not.toHaveBeenCalled();
  const persisted = kernel.setBlockAttrs.mock.calls.at(-1)![1];
  expect(JSON.parse(persisted[ATTR.attachments]!)).toHaveLength(2);
  expect(persisted[ATTR.translationMono]).toBe("assets/new-mono.pdf");
  expect(libraries.syncPaper).toHaveBeenCalledWith("existing-doc", expect.objectContaining({ canonical: expect.objectContaining({ title: "User edited" }) }), false);
});

it("deduplicates late attachment content without rewriting the paper", async () => {
  const { processor, libraries, kernel } = setup([]);
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  libraries.readPaper.mockResolvedValue(paper({ attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/existing.pdf", sha256: await sha256(bytes) }] }));
  await processor.addAttachments("doc", [{ title: "Retry", bytes, mimeType: "application/pdf" }]);
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
  expect(kernel.setBlockAttrs).not.toHaveBeenCalled();
});

it("edits metadata while preserving current attachments, translations and unrelated database changes", async () => {
  const { processor, libraries, kernel } = setup([]);
  const baseline = paper().canonical;
  const latest = paper({ canonical: { ...baseline, publisher: "Concurrent publisher" },
    attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/keep.pdf", sha256: "keep" }],
    translation: { mono: "assets/translation.pdf" } });
  libraries.readPaper.mockResolvedValue(latest);
  await processor.editMetadata("existing", baseline, { ...baseline, title: "Edited title", abstract: undefined });
  const saved = libraries.syncPaper.mock.calls[0]![1];
  expect(saved.canonical).toMatchObject({ title: "Edited title", publisher: "Concurrent publisher" });
  expect(saved.canonical.abstract).toBeUndefined();
  expect(saved.attachments).toEqual(latest.attachments);
  expect(saved.translation).toEqual(latest.translation);
  expect(saved.citekey).toBe(latest.citekey);
  expect(libraries.syncPaper).toHaveBeenNthCalledWith(1, "existing", saved, true);
  expect(kernel.createDocument).not.toHaveBeenCalled();
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
});

it("rejects concurrent edits of the same metadata field before writing", async () => {
  const { processor, libraries, kernel } = setup([]);
  const baseline = paper().canonical;
  libraries.readPaper.mockResolvedValue(paper({ canonical: { ...baseline, title: "Changed elsewhere" } }));
  await expect(processor.editMetadata("existing", baseline, { ...baseline, title: "My edit" })).rejects.toThrow("已在数据库中更改");
  expect(libraries.syncPaper).not.toHaveBeenCalled();
  expect(kernel.setBlockAttrs).not.toHaveBeenCalled();
});

it("changes citekey on the existing document without creating or uploading anything", async () => {
  const { processor, libraries, kernel } = setup([]);
  const original = paper({ translation: { mono: "assets/keep.pdf" } });
  libraries.readPaper.mockResolvedValue(structuredClone(original));
  await processor.editMetadata("existing", original.canonical, original.canonical,
    { baseline: original.citekey, value: "zhang2026new" });
  expect(libraries.citekeys).toHaveBeenCalledWith("library-doc", "existing");
  expect(libraries.syncPaper).toHaveBeenNthCalledWith(1, "existing",
    expect.objectContaining({ citekey: "zhang2026new", translation: original.translation }), true);
  expect(kernel.renameDocument).toHaveBeenCalledWith("existing", "zhang2026new");
  expect(kernel.createDocument).not.toHaveBeenCalled();
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
});

it.each(["", "bad/key", "bad key", "x".repeat(121)])("rejects invalid citekey %s before writes", async value => {
  const { processor, libraries, kernel } = setup([]);
  const original = paper();
  await expect(processor.editMetadata("existing", original.canonical, original.canonical,
    { baseline: original.citekey, value })).rejects.toThrow("引用键须");
  expect(libraries.syncPaper).not.toHaveBeenCalled();
  expect(kernel.renameDocument).not.toHaveBeenCalled();
});

it("rejects case-insensitive citekey collisions before writes", async () => {
  const { processor, libraries, kernel } = setup([]);
  libraries.citekeys.mockResolvedValue(["TakenKey"]);
  const original = paper();
  await expect(processor.editMetadata("existing", original.canonical, original.canonical,
    { baseline: original.citekey, value: "takenkey" })).rejects.toThrow("同库其他条目");
  expect(libraries.syncPaper).not.toHaveBeenCalled();
  expect(kernel.renameDocument).not.toHaveBeenCalled();
});

it("rejects concurrent citekey edits", async () => {
  const { processor, libraries } = setup([]);
  const original = paper();
  libraries.readPaper.mockResolvedValue(paper({ citekey: "changedElsewhere" }));
  await expect(processor.editMetadata("existing", original.canonical, original.canonical,
    { baseline: original.citekey, value: "myKey" })).rejects.toThrow("引用键已在数据库中更改");
  expect(libraries.syncPaper).not.toHaveBeenCalled();
});

it("can retry a rename after the citekey was already committed", async () => {
  const { processor, libraries, kernel } = setup([]);
  const original = paper();
  libraries.readPaper.mockResolvedValue(paper({ citekey: "newKey" }));
  kernel.renameDocument.mockRejectedValueOnce(new Error("rename failed"));
  const save = () => processor.editMetadata("existing", original.canonical, original.canonical,
    { baseline: original.citekey, value: "newKey" });
  await expect(save()).rejects.toThrow("rename failed");
  await save();
  expect(kernel.renameDocument).toHaveBeenCalledTimes(2);
  expect(kernel.createDocument).not.toHaveBeenCalled();
});
