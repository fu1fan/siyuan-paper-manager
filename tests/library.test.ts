import { LibraryService, canonicalFromRow, metadataFieldValue } from "../src/services/library-service";
import { ATTR } from "../src/constants";
import { decodeLibraryData, encodeLibraryData } from "../src/core/codec";
import type { KernelClient } from "../src/core/kernel";
import {
  LIBRARY_DATABASE_FIELD_LABELS,
  LIBRARY_FIELD_LABELS,
  LIBRARY_METADATA_FIELDS,
  type PaperLibraryData,
} from "../src/types/library";
import { exportCitations } from "../src/services/citation-export";
import { paper } from "./fixtures";

function fullLibraryData(overrides: Partial<PaperLibraryData> = {}): PaperLibraryData {
  return {
    schemaVersion: 3,
    avId: "av",
    avBlockId: "av-block",
    fieldKeyIds: Object.fromEntries(LIBRARY_METADATA_FIELDS.map((field) => [field, `${field}-key`])),
    projectKeyId: "project-key",
    databaseKeyIds: { addedAt: "addedAt-key", readingStatus: "readingStatus-key", rating: "rating-key" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("library database projection", () => {
  it("exports projects directly from database values, including manual additions and renames", async () => {
    let names = ["手动项目", "另一个项目"];
    const data = { ...fullLibraryData(), projects: [{ id: "old-id", name: "旧项目", docId: "old-note" }] };
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: JSON.stringify(data) }),
      query: async () => [{ content: "库" }],
      getAttributeView: async () => ({ av: { keyValues: [
        { key: { id: "block", type: "block" }, values: [{ blockID: "item", block: { id: "doc", content: "论文" } }] },
        { key: { id: "project-key", type: "mSelect" }, values: [{ blockID: "item", mSelect: names.map((content) => ({ content })) }] },
        { key: { id: "citekey-key", type: "text" }, values: [{ blockID: "item", text: { content: "manual2026" } }] },
      ] } }),
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    for (const current of [["手动项目", "另一个项目"], ["重命名项目"], []]) {
      names = current;
      const records = await service.listPapers("library");
      expect(records[0]!.projectNames).toEqual(current);
      const selected = current.length ? records.filter((record) => record.projectNames.includes(current[0]!)) : records;
      expect(exportCitations(selected.map((record) => record.paper), "bibtex").content).toContain("manual2026");
    }
  });

  it("leaves existing libraries and manual project options untouched during discovery", async () => {
    const data = { ...fullLibraryData(), projects: [{ id: "old", name: "旧项目", docId: "note" }] };
    const add = vi.fn();
    const remove = vi.fn();
    const save = vi.fn();
    const options = vi.fn();
    const fake = {
      listRowsByAttribute: async () => [{ id: "library", value: JSON.stringify(data) }],
      getAttributeView: async () => ({ av: { keyValues: [
        ...LIBRARY_METADATA_FIELDS.map((field) => ({ key: { id: data.fieldKeyIds[field], name: LIBRARY_FIELD_LABELS[field], type: "text" } })),
        ...Object.entries(LIBRARY_DATABASE_FIELD_LABELS).map(([field, name]) => ({ key: { id: `${field}-key`, name, type: "select" } })),
        { key: { id: "project-key", name: "所属项目", type: "mSelect", options: [{ name: "手动项目", color: "3" }] } },
      ] } }),
      addAttributeViewKey: add, removeAttributeViewKey: remove,
      setBlockAttrs: save, setAttributeViewSelectOptions: options,
    } as unknown as KernelClient;
    await new LibraryService(fake).discoverLibraries();
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(options.mock.calls.some((call) => call[1] === "project-key")).toBe(false);
  });

  it("projects canonical fields into SiYuan AV values", () => {
    const value = metadataFieldValue("authors", paper());
    expect(value.text?.content).toBe("张, 三");
    expect(metadataFieldValue("tags", paper()).mSelect?.map((item) => item.content)).toEqual(["测试", "paper"]);
    expect(metadataFieldValue("title", paper()).text?.content).toBe(paper().canonical.title);
    expect(metadataFieldValue("url", paper({ canonical: { ...paper().canonical, url: "https://example.com" } })).url?.content)
      .toBe("https://example.com");
  });

  it("prefers the title column over the block column content", () => {
    const row = { id: "item", cells: [
      { value: { block: { id: "doc", content: "tang2026wikiskill" } } },
      { value: { keyID: "title-key", text: { content: "真实标题" } } },
    ] };
    expect(canonicalFromRow(fullLibraryData(), row).title).toBe("真实标题");
    // 旧行没有标题列内容时回退到块列
    expect(canonicalFromRow(fullLibraryData(), { id: "item", cells: [row.cells[0]!] }).title).toBe("tang2026wikiskill");
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

  it("confirms a new row through the bound-item mapping when the rendered view is stale", async () => {
    const current = paper();
    let added = false;
    const cells: Array<{ keyID: string; itemID: string }> = [];
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(fullLibraryData()) }),
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      // 视图渲染快照始终是旧的（内核异步落库），不包含新行
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: 0,
        rows: [],
      } }),
      addAttributeViewBlocks: async () => { added = true; },
      getAttributeViewItemIDsByBoundIDs: async (_avId: string, blockIds: string[]) =>
        Object.fromEntries(blockIds.map((id) => [id, added && id === "paper-doc" ? "mapped-item-id" : ""])),
      setAttributeViewCell: async (_avID: string, keyID: string, itemID: string) => { cells.push({ keyID, itemID }); },
      setBlockAttrs: async () => {},
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    expect(await service.syncPaper("paper-doc", current, true)).toBe("mapped-item-id");
    expect(cells).toHaveLength(LIBRARY_METADATA_FIELDS.length + 2);
    expect(cells).toContainEqual({ keyID: "citekey-key", itemID: "mapped-item-id" });
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
      initializeAttributeViewLayout: vi.fn(),
      setBlockAttrs: async (_id: string, attrs: Record<string, string>) => { savedAttrs = attrs; },
    } as unknown as KernelClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const library = await new LibraryService(fake).createLibrary("box", "/论文文献库", "论文文献库");

    expect(library.docId).toBe("library-doc");
    expect(addedKeys).toHaveLength(1 + 3 + LIBRARY_METADATA_FIELDS.length + 1);
    expect(addedKeys.at(-1)).toEqual({ name: "备注", type: "text" });
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
    await expect(service.readPaper("other-doc")).rejects.toThrow(/没有绑定该文档/);
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

  it("keeps bound rows when the membership attribute index is empty", async () => {
    const data = fullLibraryData();
    const remove = vi.fn();
    const add = vi.fn();
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(data) }),
      query: async () => [{ content: "库" }],
      listRowsByAttribute: async () => [],
      getAttributeView: async () => ({ av: { id: "av", name: "库", keyValues: [
        { key: { id: "block-key", name: "文档", type: "block" }, values: [
          { blockID: "item", block: { id: "doc", content: "paper" } },
        ] },
        { key: { id: "title-key", name: "标题", type: "text" }, values: [
          { blockID: "item", text: { content: "保留的论文" } },
        ] },
      ] } }),
      removeAttributeViewBlocks: remove, addAttributeViewBlocks: add,
      setAttributeViewSelectOptions: async () => {},
    } as unknown as KernelClient;
    const result = await new LibraryService(fake).syncLibrary("library-doc");
    expect(result).toMatchObject({ papers: 1, restoredRows: 0, removedRows: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("backfills empty title cells from the paper's first heading on sync", async () => {
    const libraryData = fullLibraryData();
    const keyValues = [
      { key: { id: "block-key", name: "文档", type: "block" }, values: [
        { blockID: "item-1", block: { id: "paper-doc", content: "tang2026wikiskill" } },
      ] },
      { key: { id: "project-key", name: "所属项目", type: "mSelect" } },
      ...Object.entries(LIBRARY_DATABASE_FIELD_LABELS).map(([field, name]) => ({
        key: { id: `${field}-key`, name, type: field === "addedAt" ? "created" : "select" },
      })),
      ...Object.entries(LIBRARY_FIELD_LABELS).map(([field, name]) => ({ key: { id: `${field}-key`, name, type: "text" } })),
    ];
    const cells: Array<{ keyID: string; content: unknown }> = [];
    const fake = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(libraryData) }),
      query: async (stmt: string) => stmt.includes("subtype = 'h1'")
        ? [{ root_id: "paper-doc", content: "论文页的真实标题" }]
        : [{ content: "库", hpath: "/库", box: "box" }],
      listRowsByAttribute: async (name: string) => name === ATTR.libraryId
        ? [{ id: "paper-doc", content: "tang2026wikiskill" }]
        : [],
      getAttributeView: async () => ({ av: { id: "av", name: "库", keyValues } }),
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: 1,
        rows: [{ id: "item-1", cells: [
          { value: { block: { id: "paper-doc", content: "tang2026wikiskill" } } },
          { value: { keyID: "title-key", text: { content: "" } } },
        ] }],
      } }),
      setAttributeViewCell: async (_avId: string, keyID: string, _itemID: string, value: { text?: { content?: string } }) => {
        cells.push({ keyID, content: value.text?.content });
      },
      setAttributeViewSelectOptions: async () => {},
      removeAttributeViewBlocks: async () => {},
    } as unknown as KernelClient;

    const result = await new LibraryService(fake).syncLibrary("library-doc");

    expect(result.papers).toBe(1);
    expect(cells).toEqual([{ keyID: "title-key", content: "论文页的真实标题" }]);
  });

});

describe("library data decoding", () => {
  it("round-trips plain JSON payloads", () => {
    const data = fullLibraryData();
    expect(decodeLibraryData(encodeLibraryData(data))).toEqual(data);
  });

  it("upgrades schema v1/v2 payloads and drops column management fields", () => {
    const decoded = decodeLibraryData(JSON.stringify({
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
    expect("projects" in decoded).toBe(false);
    expect("selectedFields" in decoded).toBe(false);
    expect("columnOrder" in decoded).toBe(false);
  });
});
