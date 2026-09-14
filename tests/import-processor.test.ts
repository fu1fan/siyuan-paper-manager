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

it("saves staged files, a designated original, snapshot renames and translation renames together", async () => {
  const { processor, libraries, kernel } = setup([]);
  const before = paper({ attachments: [{ title: "Snapshot", mimeType: "text/html", assetAddress: "assets/snapshot.html", sha256: "html" }], translation: { mono: "assets/mono.pdf" } });
  libraries.readPaper.mockResolvedValue(before);
  const draft = structuredClone(before);
  draft.attachments[0]!.title = "网页快照";
  draft.attachments.push({ title: "原稿", mimeType: "application/pdf", assetAddress: "pending:1", sha256: "" });
  draft.originalPdf = "pending:1";
  draft.translation.monoTitle = "中文译稿";
  await processor.editMetadata("existing", before.canonical, before.canonical, undefined, { baseline: before, draft,
    additions: [{ id: "pending:1", bytes: new TextEncoder().encode("%PDF-1.4 original"), title: "original.pdf", mimeType: "application/pdf" }] });
  const attrs = kernel.setBlockAttrs.mock.calls.at(-1)![1];
  expect(attrs[ATTR.originalPdf]).toBe("assets/new.pdf");
  expect(attrs[ATTR.translationMonoTitle]).toBe("中文译稿");
  expect(JSON.parse(attrs[ATTR.attachments]!)).toEqual(expect.arrayContaining([expect.objectContaining({ title: "原稿", assetAddress: "assets/new.pdf" }), expect.objectContaining({ title: "网页快照" })]));
});
it("can add a translation file without adding it to original PDF candidates", async () => {
  const { processor, libraries, kernel } = setup([]);
  const before = paper(); libraries.readPaper.mockResolvedValue(before);
  const draft = structuredClone(before); draft.translation.dual = "pending:1"; draft.translation.dualTitle = "Bilingual";
  await processor.editMetadata("existing", before.canonical, before.canonical, undefined, { baseline: before, draft,
    additions: [{ id: "pending:1", bytes: new TextEncoder().encode("%PDF-1.4 dual"), title: "dual.pdf", mimeType: "application/pdf" }] });
  const attrs = kernel.setBlockAttrs.mock.calls.at(-1)![1];
  expect(attrs[ATTR.translationDual]).toBe("assets/new.pdf");
  expect(attrs[ATTR.translationDualTitle]).toBe("Bilingual");
  expect(JSON.parse(attrs[ATTR.attachments]!)).toEqual([]);
});

it("imports only confirmed staged files and keeps their edited name and original PDF selection", async () => {
  const { processor, kernel, libraries } = setup([]);
  const incoming = candidate();
  incoming.attachments = [{ title: "removed.pdf", mimeType: "application/pdf", bytes: new Uint8Array([0]) }];
  incoming.attachmentEdit = {
    baseline: { attachments: [], translation: {} },
    draft: { attachments: [{ title: "论文原稿", mimeType: "application/pdf", assetAddress: "pending:browser", sha256: "" }], translation: {}, originalPdf: "pending:browser" },
    additions: [{ id: "pending:browser", title: "browser.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
  };
  await processor.process(incoming);
  expect(kernel.uploadAsset).toHaveBeenCalledTimes(1);
  expect(libraries.syncPaper).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    attachments: [expect.objectContaining({ title: "论文原稿", assetAddress: "assets/new.pdf" })],
    originalPdf: "assets/new.pdf",
  }), true);
});

it("does not upload browser attachments removed in the confirmation dialog", async () => {
  const { processor, kernel } = setup([]);
  const incoming = candidate();
  incoming.attachments = [{ title: "removed.pdf", mimeType: "application/pdf", bytes: new Uint8Array([0]) }];
  incoming.attachmentEdit = { baseline: { attachments: [], translation: {} }, draft: { attachments: [], translation: {} }, additions: [] };
  await processor.process(incoming);
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
});

it("saves the confirmed citekey and uses it for the document name", async () => {
  const { processor, kernel, libraries } = setup([]);
  await processor.process({ ...candidate(), citekey: 'myPaper2026' });
  expect(kernel.createDocument.mock.calls[0]).toContain('myPaper2026');
  expect(libraries.syncPaper).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ citekey: 'myPaper2026' }), true);
});
it("rejects invalid confirmed citekeys before creating or uploading", async () => {
  const { processor, kernel } = setup([]);
  await expect(processor.process({ ...candidate(), citekey: '待确认' })).rejects.toThrow('引用键须为');
  expect(kernel.createDocument).not.toHaveBeenCalled();
  expect(kernel.uploadAsset).not.toHaveBeenCalled();
});

describe("refreshing a paper's metadata summary", () => {
  it("rebuilds the summary from the database row without rewriting metadata columns", async () => {
    const { processor, kernel, libraries } = setup([]);
    await processor.repair("paper-doc");
    expect(libraries.readPaper).toHaveBeenCalledWith("paper-doc");
    // The database stays authoritative: repair must not push metadata back into columns.
    expect(libraries.syncPaper).toHaveBeenCalledWith("paper-doc", expect.anything(), false);
    expect(kernel.setBlockAttrs).toHaveBeenCalled();
  });

  it("serializes repair with an import so a concurrent import cannot interleave", async () => {
    const order: string[] = [];
    const { processor, libraries } = setup([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    libraries.readPaper.mockImplementation(async () => { order.push("repair-read"); await gate; return paper(); });
    const repair = processor.repair("paper-doc").then(() => order.push("repair-done"));
    const second = processor.repair("paper-doc").then(() => order.push("second-done"));
    release();
    await Promise.all([repair, second]);
    expect(order).toEqual(["repair-read", "repair-done", "repair-read", "second-done"]);
  });
});
