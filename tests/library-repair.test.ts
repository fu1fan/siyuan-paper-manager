import { ATTR } from "../src/constants";
import { decodeLibraryData, encodeLibraryData } from "../src/core/codec";
import type { KernelClient } from "../src/core/kernel";
import { LibraryService } from "../src/services/library-service";
import { LIBRARY_DATABASE_FIELD_LABELS, LIBRARY_FIELD_LABELS, LIBRARY_METADATA_FIELDS, type PaperLibraryData } from "../src/types/library";

function libraryData(overrides: Partial<PaperLibraryData> = {}): PaperLibraryData {
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

function metadataKeyType(field: string): string {
  return field === "tags" ? "mSelect" : field === "itemType" ? "select" : field === "url" ? "url" : "text";
}

/**
 * Kernel stub modelling a database whose original AV is corrupt.  Column
 * metadata is stateful so `ensureSchemaFields` behaves as it does in SiYuan:
 * existing columns are reused rather than recreated.
 */
function kernelFixture(options: { corrupt: boolean }) {
  const labels = [
    { name: "所属项目", type: "mSelect" },
    ...(["addedAt", "readingStatus", "rating"] as const).map((field) => ({ name: LIBRARY_DATABASE_FIELD_LABELS[field], type: field === "addedAt" ? "created" : "select" })),
    ...LIBRARY_METADATA_FIELDS.map((field) => ({ name: LIBRARY_FIELD_LABELS[field], type: metadataKeyType(field) })),
  ];
  // The original database already has every managed column under its recorded ids.
  const columns = new Map<string, Array<{ id: string; name: string; type: string }>>([
    ["av", labels.map((label, index) => ({ id: `${label.name}-${index}`, ...label }))],
  ]);
  const createdKeyNames: string[] = [];
  let saved: Record<string, string> = {};
  const kernel = {
    getBlockAttrs: async () => ({ [ATTR.libraryData]: saved[ATTR.libraryData] ?? encodeLibraryData(libraryData()) }),
    query: async () => [{ content: "库", hpath: "/库", box: "box" }],
    listRowsByAttribute: async () => [{ id: "paper-doc", value: "library", content: "论文" }],
    renderAttributeView: async (avId: string) => {
      if (options.corrupt && avId === "av") throw new Error("数据库文件损坏");
      return { id: avId, name: "库", viewID: "view", viewType: "table", view: { rowCount: 0, rows: [] } };
    },
    getAttributeView: async (avId: string) => {
      if (options.corrupt && avId === "av") throw new Error("数据库文件损坏");
      return { av: { keyValues: (columns.get(avId) ?? []).map((column) => ({ key: column, values: [] })) } };
    },
    appendAttributeViewBlock: async () => "new-block",
    setAttributeViewName: async () => { throw new Error("旧版内核不支持重命名"); },
    addAttributeViewKey: async (avId: string, keyId: string, keyName: string, keyType: string) => {
      createdKeyNames.push(keyName);
      const list = columns.get(avId) ?? [];
      list.push({ id: keyId, name: keyName, type: keyType });
      columns.set(avId, list);
    },
    setAttributeViewSelectOptions: async () => {},
    addAttributeViewBlocks: async () => {},
    setAttributeViewCell: async () => {},
    setBlockAttrs: async (_id: string, attrs: Record<string, string>) => { saved = { ...saved, ...attrs }; },
  };
  return { kernel: kernel as unknown as KernelClient, createdKeyNames, columns, savedAttrs: () => saved };
}

describe("library database repair", () => {
  it("keeps the database and runs a normal sync when the view renders", async () => {
    const { kernel, createdKeyNames } = kernelFixture({ corrupt: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await new LibraryService(kernel).repairLibrary("library");
    // No rebuild: existing columns are reused, never recreated.
    expect(createdKeyNames).toEqual([]);
    expect(result.restoredRows).toBe(1);
    expect(result.failed).toEqual([]);
    warn.mockRestore();
  });

  it("rebuilds a corrupt database, recreates every column and persists the new avId", async () => {
    const { kernel, createdKeyNames, savedAttrs } = kernelFixture({ corrupt: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await new LibraryService(kernel).repairLibrary("library");

    // The rebuilt database gets a fresh id and the full column set (project + 3 database + metadata).
    const rebuilt = decodeLibraryData(savedAttrs()[ATTR.libraryData]!);
    expect(rebuilt.avId).not.toBe("av");
    expect(rebuilt.avBlockId).toBe("new-block");
    expect(createdKeyNames).toHaveLength(1 + 3 + LIBRARY_METADATA_FIELDS.length);
    expect(createdKeyNames[0]).toBe("所属项目");
    expect(Object.keys(rebuilt.fieldKeyIds)).toHaveLength(LIBRARY_METADATA_FIELDS.length);
    expect(Object.keys(rebuilt.databaseKeyIds)).toHaveLength(3);
    // Rows are restored from membership attributes after the rebuild.
    expect(result.restoredRows).toBe(1);
    warn.mockRestore();
  });

  it("restores rows from bound members even when the membership attribute index is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No document carries custom-paper-library-id, yet the database itself has a bound row.
    const bound = {
      getBlockAttrs: async () => ({ [ATTR.libraryData]: encodeLibraryData(libraryData()) }),
      query: async () => [{ content: "库", hpath: "/库", box: "box" }],
      listRowsByAttribute: async () => [],
      renderAttributeView: async () => ({ id: "av", name: "库", viewID: "view", viewType: "table", view: { rowCount: 0, rows: [] } }),
      getAttributeView: async () => ({ av: { keyValues: [
        { key: { id: "block", type: "block" }, values: [{ blockID: "item", block: { id: "bound-doc", content: "绑定论文" } }] },
      ] } }),
      addAttributeViewBlocks: async () => {},
      setAttributeViewCell: async () => {},
      setBlockAttrs: async () => {},
    } as unknown as KernelClient;
    const result = await new LibraryService(bound).repairLibrary("library");
    expect(result.papers).toBe(1);
    expect(result.restoredRows).toBe(0);
    warn.mockRestore();
  });
});
