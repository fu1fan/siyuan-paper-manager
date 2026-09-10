import { ATTR } from "../src/constants";
import { encodeLibraryData } from "../src/core/codec";
import type { KernelClient } from "../src/core/kernel";
import type { TemplateService } from "../src/core/templates";
import { LibraryService } from "../src/services/library-service";
import { ItemProcessor } from "../src/services/item-processor";
import { LIBRARY_METADATA_FIELDS } from "../src/types/library";
import type { PluginSettings } from "../src/types/settings";
import { paper } from "./fixtures";

function fixture() {
  const data = {
    schemaVersion: 3 as const, avId: "av", avBlockId: "av-block",
    fieldKeyIds: Object.fromEntries(LIBRARY_METADATA_FIELDS.map((f) => [f, `${f}-key`])),
    projectKeyId: "project-key", databaseKeyIds: { addedAt: "added", readingStatus: "status", rating: "rating" },
    projects: [], createdAt: "", updatedAt: "",
  };
  const definition = { av: { id: "av", name: "库", keyValues: [
    { key: { id: "block-key", name: "文档", type: "block" }, values: [
      { blockID: "item", block: { id: "doc", content: "citekey" } },
      { blockID: "detached", isDetached: true, block: { id: "unbound", content: "游离行" } },
    ] },
    { key: { id: "title-key", name: "标题", type: "text" }, values: [
      { blockID: "item", text: { content: "数据库中的真实标题" } },
    ] },
  ] } };
  const fake = {
    parentDocumentId: vi.fn(async () => "library-doc"),
    getBlockAttrs: vi.fn(async (id: string) => id === "library-doc" ? { [ATTR.libraryData]: encodeLibraryData(data) } : { [ATTR.libraryId]: "stale-library" }),
    query: vi.fn(async () => [{ content: "库" }]),
    listRowsByAttribute: vi.fn(async () => [{ id: "library-doc", value: encodeLibraryData(data) }]),
    getAttributeView: vi.fn(async () => definition),
    getAttributeViewItemIDsByBoundIDs: vi.fn(async () => ({ doc: "item" })),
    renderAttributeView: vi.fn(async () => ({ view: { rows: [], rowCount: 0 } })),
    addAttributeViewBlocks: vi.fn(), setAttributeViewCell: vi.fn(), setBlockAttrs: vi.fn(),
  };
  return { fake, service: new LibraryService(fake as unknown as KernelClient) };
}

describe("paper binding independent of rendered views", () => {
  it("reads bound metadata even when the rendered view hides every row", async () => {
    const { fake, service } = fixture();
    expect((await service.readPaper("doc")).canonical.title).toBe("数据库中的真实标题");
    expect((await service.readPaper("doc")).libraryId).toBe("library-doc");
    expect(fake.renderAttributeView).not.toHaveBeenCalled();
    expect(await service.findPaperEntry("unbound")).toBeNull();
  });

  it("does not reinsert hidden rows or reset reading fields during refresh", async () => {
    const { fake, service } = fixture();
    expect(await service.syncPaper("doc", paper())).toBe("item");
    expect(fake.addAttributeViewBlocks).not.toHaveBeenCalled();
    expect(fake.setAttributeViewCell).not.toHaveBeenCalled();
  });

  it("waits for bound row data to become readable without manual synchronization", async () => {
    const { fake, service } = fixture();
    fake.getAttributeView.mockResolvedValueOnce({ av: { id: "av", name: "库", keyValues: [
      { key: { id: "block-key", name: "文档", type: "block" }, values: [] },
    ] } });
    expect((await service.readPaper("doc")).canonical.title).toBe("数据库中的真实标题");
    expect(fake.addAttributeViewBlocks).not.toHaveBeenCalled();
  });

  it("uses raw rows even when the mapping API is unavailable", async () => {
    const { fake, service } = fixture();
    fake.getAttributeViewItemIDsByBoundIDs.mockRejectedValue(new Error("unsupported"));
    expect((await service.requirePaperEntry("doc")).itemId).toBe("item");
  });
});

describe("automatic database synchronization", () => {
  function processor(syncPaper: ReturnType<typeof vi.fn>) {
    return new ItemProcessor(
      { setBlockAttrs: vi.fn() } as unknown as KernelClient,
      { refreshMeta: vi.fn() } as unknown as TemplateService,
      () => ({} as PluginSettings), vi.fn(),
      { syncPaper } as unknown as LibraryService,
    );
  }

  it("automatically retries transient failures with the original import metadata", async () => {
    const sync = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue("item");
    const current = paper();
    await processor(sync).persistAndRefresh("doc", current, undefined, true);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith("doc", current, true);
  });

  it("reports persistent failures instead of silently returning success", async () => {
    const sync = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(processor(sync).persistAndRefresh("doc", paper())).rejects.toThrow(/自动重试后仍失败.*offline/);
    expect(sync).toHaveBeenCalledTimes(3);
  });
});

it("updates the citekey in place without reinserting the row or resetting reading/project fields", async () => {
  const { fake, service } = fixture();
  expect(await service.syncPaper("doc", paper({ citekey: "newKey" }), true)).toBe("item");
  expect(fake.addAttributeViewBlocks).not.toHaveBeenCalled();
  expect(fake.setAttributeViewCell).toHaveBeenCalledWith("av", "citekey-key", "item", { type: "text", text: { content: "newKey" } });
  for (const call of fake.setAttributeViewCell.mock.calls as unknown as unknown[][]) {
    expect(call[2]).toBe("item");
    expect(["status", "rating", "project-key", "added"]).not.toContain(call[1]);
  }
});
