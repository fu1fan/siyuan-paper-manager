import { TemplateService } from "../src/core/templates";
import { ATTR } from "../src/constants";
import type { KernelClient } from "../src/core/kernel";
import { applyDocumentTag, syncDocumentTags } from "../src/services/document-tags";
import { normalizeSettings } from "../src/types/settings";

function fixture() {
  const attrs: Record<string, Record<string, string>> = { paper: { tags: "个人,精读" }, manual: { tags: "其他" } };
  const kernel = {
    getBlockAttrs: vi.fn(async (id: string) => ({ ...attrs[id] })),
    setBlockAttrs: vi.fn(async (id: string, values: Record<string,string>) => { Object.assign(attrs[id]!, values); }),
    query: vi.fn(async (sql: string) => sql.includes("JOIN attributes") ? [
      { id: "lib", name: ATTR.libraryData, value: JSON.stringify({ avId: "av", avBlockId: "block", projectKeyId: "project", schemaVersion: 3 }) },
      { id: "paper", name: ATTR.libraryId, value: "lib" },
    ] : sql.includes("'gone'") ? [] : [{ id: "exists" }]),
    getAttributeView: vi.fn(async () => ({ av: { keyValues: [{ key: { type: "block" }, values: [
      { block: { id: "manual" } }, { block: { id: "gone" } }, { isDetached: true, block: { id: "detached" } },
    ] }] } })),
  };
  return { attrs, kernel, client: kernel as unknown as KernelClient };
}

it("adds, replaces and removes only the managed native document tag", async () => {
  const { attrs, client, kernel } = fixture();
  await applyDocumentTag(client, "paper", "论文");
  expect(attrs.paper!.tags).toBe("个人,精读,论文");
  await applyDocumentTag(client, "paper", "文献/论文");
  expect(attrs.paper!.tags).toBe("个人,精读,文献/论文");
  await applyDocumentTag(client, "paper", "");
  expect(attrs.paper!.tags).toBe("个人,精读");
  const count = kernel.setBlockAttrs.mock.calls.length;
  await applyDocumentTag(client, "paper", "");
  expect(kernel.setBlockAttrs).toHaveBeenCalledTimes(count);
});

it("deduplicates an existing chosen tag and repairs manually removed defaults", async () => {
  const { attrs, client } = fixture();
  await applyDocumentTag(client, "paper", "精读");
  expect(attrs.paper!.tags!.split(",").filter(tag => tag === "精读")).toHaveLength(1);
  attrs.paper!.tags = "个人";
  await applyDocumentTag(client, "paper", "精读");
  expect(attrs.paper!.tags).toBe("个人,精读");
});

it("includes database-bound notes without machine attrs and skips missing/detached notes", async () => {
  const { attrs, client, kernel } = fixture();
  await syncDocumentTags(client, "论文");
  expect(attrs.paper!.tags).toContain("论文");
  expect(attrs.manual!.tags).toBe("其他,论文");
  expect(kernel.setBlockAttrs.mock.calls.map(call => call[0])).toEqual(["paper", "manual"]);
});

it("continues after a failed write and retries using each document's old marker", async () => {
  const { attrs, client, kernel } = fixture();
  await syncDocumentTags(client, "旧标签");
  kernel.setBlockAttrs.mockRejectedValueOnce(new Error("write failed"));
  await expect(syncDocumentTags(client, "新标签")).rejects.toThrow("再次保存可重试");
  expect(attrs.paper![ATTR.defaultDocumentTag]).toBe("旧标签");
  expect(attrs.manual![ATTR.defaultDocumentTag]).toBe("新标签");
  await syncDocumentTags(client, "");
  expect(attrs.paper!.tags).toBe("个人,精读");
  expect(attrs.manual!.tags).toBe("其他");
});

it("defaults old settings to no tag and trims the configured label", () => {
  expect(normalizeSettings({}).defaultDocumentTag).toBe("");
  expect(normalizeSettings({ defaultDocumentTag: "  论文  " }).defaultDocumentTag).toBe("论文");
});


it("applies the current setting when standard paper sections are prepared", async () => {
  const { client, kernel, attrs } = fixture();
  Object.assign(kernel, { findSectionBlock: vi.fn(async (_id: string, section: string) => section) });
  let setting = "新论文";
  const templates = new TemplateService(client, { getDefaultDocumentTag: () => setting });
  await templates.ensureSections("paper", {} as never);
  expect(attrs.paper!.tags).toBe("个人,精读,新论文");
  setting = "";
  await templates.ensureSections("paper", {} as never);
  expect(attrs.paper!.tags).toBe("个人,精读");
});
