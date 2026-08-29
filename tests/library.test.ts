import { LibraryService, metadataFieldValue } from "../src/services/library-service";
import { ATTR } from "../src/constants";
import { decodeLibraryData, encodeLibraryData } from "../src/core/codec";
import type { KernelClient } from "../src/core/kernel";
import {
  LIBRARY_METADATA_FIELDS,
  type PaperLibraryData,
} from "../src/types/library";
import { paper } from "./fixtures";

function fullLibraryData(overrides: Partial<PaperLibraryData> = {}): PaperLibraryData {
  return {
    schemaVersion: 3,
    avId: "av",
    avBlockId: "av-block",
    fieldKeyIds: Object.fromEntries(LIBRARY_METADATA_FIELDS.map((field) => [field, `${field}-key`])),
    projectKeyId: "project-key",
    databaseKeyIds: { addedAt: "addedAt-key", readingStatus: "readingStatus-key", rating: "rating-key" },
    projects: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function legacyEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

describe("library database projection", () => {
  it("projects canonical fields into SiYuan AV values", () => {
    const value = metadataFieldValue("authors", paper());
    expect(value.text?.content).toBe("张, 三");
    expect(metadataFieldValue("tags", paper()).mSelect?.map((item) => item.content)).toEqual(["测试", "paper"]);
    expect(metadataFieldValue("url", paper({ canonical: { ...paper().canonical, url: "https://example.com" } })).url?.content)
      .toBe("https://example.com");
  });

  it("creates the bound row and writes every metadata cell on import", async () => {
    const current = paper();
    const cells: Array<{ keyID: string; itemID: string }> = [];
    let added = false;
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(fullLibraryData()) }),
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: added ? 1 : 0,
        rows: added ? [{ id: "real-item-id", cells: [{ value: { block: { id: "paper-doc" } } }] }] : [],
      } }),
      addAttributeViewBlocks: async () => { added = true; },
      setAttributeViewCell: async (_avID: string, keyID: string, itemID: string) => { cells.push({ keyID, itemID }); },
      setBlockAttrs: async () => {},
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    expect(await service.syncPaper("paper-doc", current, true)).toBe("real-item-id");
    expect(cells).toHaveLength(LIBRARY_METADATA_FIELDS.length + 2);
    expect(cells).toContainEqual({ keyID: "citekey-key", itemID: "real-item-id" });
    expect(cells).toContainEqual({ keyID: "authors-key", itemID: "real-item-id" });
    expect(cells).toContainEqual({ keyID: "readingStatus-key", itemID: "real-item-id" });
    expect(cells).toContainEqual({ keyID: "rating-key", itemID: "real-item-id" });
  });

  it("never rewrites metadata cells without the import merge flag", async () => {
    const cells: string[] = [];
    const attrs: Record<string, string>[] = [];
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(fullLibraryData()) }),
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: 1,
        rows: [{ id: "real-item-id", cells: [{ value: { block: { id: "paper-doc" } } }] }],
      } }),
      setAttributeViewCell: async (_avID: string, keyID: string) => { cells.push(keyID); },
      setBlockAttrs: async (_id: string, value: Record<string, string>) => { attrs.push(value); },
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    expect(await service.syncPaper("paper-doc", paper())).toBe("real-item-id");
    expect(cells).toEqual([]);
    expect(attrs.at(-1)).toMatchObject({ [ATTR.librarySync]: "ready" });
  });

  it("keeps creating a usable library when the cosmetic database rename fails", async () => {
    let savedAttrs: Record<string, string> = {};
    const addedKeys: Array<{ name: string; type: string }> = [];
    const fake = {
      createDocument: async () => ({ id: "library-doc", hPath: "/论文文献库" }),
      appendAttributeViewBlock: async () => "av-block",
      renderAttributeView: async () => ({ id: "av", name: "", viewID: "view", viewType: "table", view: {} }),
      setAttributeViewName: async () => { throw new Error("旧版内核不支持数据库重命名事务"); },
      addAttributeViewKey: async (_avId: string, _keyId: string, keyName: string, keyType: string) => {
        addedKeys.push({ name: keyName, type: keyType });
      },
      setAttributeViewSelectOptions: async () => {},
      setBlockAttrs: async (_id: string, attrs: Record<string, string>) => { savedAttrs = attrs; },
    } as unknown as KernelClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const library = await new LibraryService(fake).createLibrary("box", "/论文文献库", "论文文献库");

    expect(library.docId).toBe("library-doc");
    expect(addedKeys).toHaveLength(1 + 3 + LIBRARY_METADATA_FIELDS.length);
    expect(addedKeys[0]).toEqual({ name: "所属项目", type: "mSelect" });
    expect(decodeLibraryData(savedAttrs[ATTR.libraryData]!).schemaVersion).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      "[paper-manager] 数据库重命名失败，继续创建文献库",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("reuses same-name database columns and removes duplicates instead of recreating them", async () => {
    let savedAttrs: Record<string, string> = {};
    const removed: string[] = [];
    const added: string[] = [];
    const libraryData = fullLibraryData({ fieldKeyIds: {}, databaseKeyIds: {} });
    const fake = {
      listRowsByAttribute: async (name: string) => name === ATTR.libraryData
        ? [{ id: "library-doc", content: "库", hpath: "/库", box: "box", value: encodeLibraryData(libraryData) }]
        : [],
      getAttributeView: async () => ({ av: { id: "av", name: "库", keyValues: [
        { key: { id: "block-key", name: "文档", type: "block" } },
        { key: { id: "project-key", name: "所属项目", type: "mSelect" } },
        { key: { id: "old-status", name: "阅读状态", type: "select" } },
        { key: { id: "dup-status", name: "阅读状态", type: "select" } },
        { key: { id: "old-rating", name: "论文打分", type: "select" } },
      ] } }),
      addAttributeViewKey: async (_avId: string, keyId: string) => { added.push(keyId); },
      removeAttributeViewKey: async (_avId: string, keyId: string) => { removed.push(keyId); },
      setAttributeViewSelectOptions: async () => {},
      setBlockAttrs: async (_id: string, attrs: Record<string, string>) => { savedAttrs = attrs; },
    } as unknown as KernelClient;

    const library = (await new LibraryService(fake).discoverLibraries())[0]!;

    expect(removed).toEqual(["dup-status"]);
    // 缺失的「添加时间」+ 全部 17 个元数据列
    expect(added).toHaveLength(1 + LIBRARY_METADATA_FIELDS.length);
    expect(library.data.databaseKeyIds).toEqual({
      addedAt: added[0],
      readingStatus: "old-status",
      rating: "old-rating",
    });
    expect(Object.keys(library.data.fieldKeyIds)).toHaveLength(LIBRARY_METADATA_FIELDS.length);
    expect(savedAttrs[ATTR.libraryData]).toBeTruthy();
  });

  it("locates a paper through the parent document database membership", async () => {
    const libraryData = fullLibraryData();
    const fake = {
      parentDocumentId: async (id: string) => id === "paper-doc" ? "library-doc" : "",
      listRowsByAttribute: async (name: string) => name === ATTR.libraryData
        ? [{ id: "library-doc", content: "库", hpath: "/库", box: "box", value: encodeLibraryData(libraryData) }]
        : [],
      getBlockAttrs: async (id: string) => id === "library-doc"
        ? { [ATTR.libraryData]: encodeLibraryData(libraryData) }
        : {
          [ATTR.attachments]: JSON.stringify([{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/p.pdf", sha256: "x" }]),
          [ATTR.translationMono]: "assets/mono.pdf",
        },
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      getAttributeViewItemIDsByBoundIDs: async (_avId: string, blockIds: string[]) =>
        Object.fromEntries(blockIds.map((id) => [id, id === "paper-doc" ? "item-1" : ""])),
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: 1,
        rows: [{ id: "item-1", cells: [
          { value: { block: { id: "paper-doc", content: "数据库里的标题" } } },
          { value: { keyID: "citekey-key", text: { content: "ck2026" } } },
          { value: { keyID: "authors-key", text: { content: "张, 三；李, 四" } } },
          { value: { keyID: "tags-key", mSelect: [{ content: "数据库标签" }] } },
        ] }],
      } }),
    } as unknown as KernelClient;
    const service = new LibraryService(fake);

    const entry = await service.findPaperEntry("paper-doc");
    expect(entry?.itemId).toBe("item-1");
    expect(await service.findPaperEntry("other-doc")).toBeNull();

    const paperData = await service.readPaper("paper-doc");
    expect(paperData.canonical.title).toBe("数据库里的标题");
    expect(paperData.citekey).toBe("ck2026");
    expect(paperData.canonical.creators.map((creator) => creator.family)).toEqual(["张", "李"]);
    expect(paperData.canonical.tags).toEqual(["数据库标签"]);
    expect(paperData.libraryId).toBe("library-doc");
    expect(paperData.attachments[0]?.assetAddress).toBe("assets/p.pdf");
    expect(paperData.translation.mono).toBe("assets/mono.pdf");
    await expect(service.readPaper("other-doc")).rejects.toThrow(/不是论文页/);
  });

  it("falls back to scanning every library when the paper was moved out of the library doc", async () => {
    const libraryData = fullLibraryData();
    const fake = {
      parentDocumentId: async () => "random-parent",
      listRowsByAttribute: async (name: string) => name === ATTR.libraryData
        ? [{ id: "library-doc", content: "库", hpath: "/库", box: "box", value: encodeLibraryData(libraryData) }]
        : [],
      getBlockAttrs: async () => ({}),
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      getAttributeViewItemIDsByBoundIDs: async () => ({ "paper-doc": "item-9" }),
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: 1,
        rows: [{ id: "item-9", cells: [
          { value: { block: { id: "paper-doc", content: "被移动的论文" } } },
          { value: { keyID: "citekey-key", text: { content: "moved-ck" } } },
        ] }],
      } }),
    } as unknown as KernelClient;
    const service = new LibraryService(fake);

    const paperData = await service.readPaper("paper-doc");
    expect(paperData.canonical.title).toBe("被移动的论文");
    expect(paperData.citekey).toBe("moved-ck");
  });

  it("reports the concrete lookup stage when detection fails", async () => {
    const fake = {
      parentDocumentId: async () => "random-parent",
      listRowsByAttribute: async () => [],
      getBlockAttrs: async () => ({}),
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    await expect(service.requirePaperEntry("paper-doc")).rejects.toThrow(/还没有论文文献库/);
  });

});

describe("library data decoding", () => {
  it("round-trips plain JSON payloads", () => {
    const data = fullLibraryData({ projects: [{ id: "p1", name: "项目一" }] });
    expect(decodeLibraryData(encodeLibraryData(data))).toEqual(data);
  });

  it("still reads legacy base64 payloads and upgrades schema v1/v2", () => {
    const decoded = decodeLibraryData(legacyEncode({
      schemaVersion: 2,
      avId: "av",
      avBlockId: "av-block",
      selectedFields: ["citekey"],
      columnOrder: ["rating", "project"],
      fieldKeyIds: { citekey: "cite-key" },
      projectKeyId: "project-key",
      databaseKeyIds: { rating: "rating-key" },
      projects: [{ id: "p1", name: "项目一" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(decoded.schemaVersion).toBe(3);
    expect(decoded.fieldKeyIds).toEqual({ citekey: "cite-key" });
    expect(decoded.databaseKeyIds).toEqual({ rating: "rating-key" });
    expect(decoded.projects).toEqual([{ id: "p1", name: "项目一" }]);
    expect("selectedFields" in decoded).toBe(false);
    expect("columnOrder" in decoded).toBe(false);
  });
});
