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
      schemaVersion: 1,
      avId: "av",
      avBlockId: "av-block",
      selectedFields: ["citekey"],
      fieldKeyIds: { citekey: "cite-key" },
      projectKeyId: "project-key",
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
      { keyID: "project-key", itemID: "real-item-id" },
    ]);
  });
});
