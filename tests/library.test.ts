import { LibraryService, metadataFieldValue } from "../src/services/library-service";
import { ATTR } from "../src/constants";
import { encodeLibraryData } from "../src/core/codec";
import type { KernelClient } from "../src/core/kernel";
import type { PaperLibraryData } from "../src/types/library";
import { paper } from "./fixtures";

describe("library database projection", () => {
  it("projects canonical fields into SiYuan AV values", () => {
    const value = metadataFieldValue("authors", paper());
    expect(value.text?.content).toBe("张, 三");
    expect(metadataFieldValue("tags", paper()).mSelect?.map((item) => item.content)).toEqual(["测试", "paper"]);
    expect(metadataFieldValue("url", paper({ canonical: { ...paper().canonical, url: "https://example.com" } })).url?.content)
      .toBe("https://example.com");
  });

  it("restores a missing bound row and writes cells using the rendered item id", async () => {
    const current = paper();
    const cells: Array<{ keyID: string; itemID: string }> = [];
    let added = false;
    const libraryData: PaperLibraryData = {
      schemaVersion: 2,
      avId: "av",
      avBlockId: "av-block",
      selectedFields: ["citekey"],
      fieldKeyIds: { citekey: "cite-key" },
      projectKeyId: "project-key",
      databaseKeyIds: { addedAt: "added-key", readingStatus: "status-key", rating: "rating-key" },
      columnOrder: ["project", "addedAt", "readingStatus", "rating", "citekey"],
      projects: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fake = {
      getBlockAttrs: async (id: string) => id === "library-doc" ? { [ATTR.libraryData]: encodeLibraryData(libraryData) } : {},
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: {
        rowCount: added ? 1 : 0,
        rows: added ? [{ id: "real-item-id", cells: [{ value: { block: { id: "paper-doc" } } }] }] : [],
      } }),
      addAttributeViewBlocks: async () => { added = true; },
      setAttributeViewCell: async (_avID: string, keyID: string, itemID: string) => { cells.push({ keyID, itemID }); },
      setBlockAttrs: async () => {},
      getPaperData: async () => current,
    } as unknown as KernelClient;
    const service = new LibraryService(fake);
    expect(await service.syncPaper("paper-doc", current)).toBe("real-item-id");
    expect(cells).toEqual([
      { keyID: "cite-key", itemID: "real-item-id" },
      { keyID: "status-key", itemID: "real-item-id" },
      { keyID: "rating-key", itemID: "real-item-id" },
    ]);
  });

  it("keeps creating a usable library when the cosmetic database rename fails", async () => {
    let savedAttrs: Record<string, string> = {};
    const fake = {
      createDocument: async () => ({ id: "library-doc", hPath: "/论文文献库" }),
      appendAttributeViewBlock: async () => "av-block",
      renderAttributeView: async () => ({ id: "av", name: "", viewID: "view", viewType: "table", view: {} }),
      setAttributeViewName: async () => { throw new Error("旧版内核不支持数据库重命名事务"); },
      addAttributeViewKey: async () => {},
      setBlockAttrs: async (_id: string, attrs: Record<string, string>) => { savedAttrs = attrs; },
    } as unknown as KernelClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const library = await new LibraryService(fake).createLibrary("box", "/论文文献库", "论文文献库");

    expect(library.docId).toBe("library-doc");
    expect(savedAttrs[ATTR.libraryData]).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[paper-manager] 数据库重命名失败，继续创建文献库",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
