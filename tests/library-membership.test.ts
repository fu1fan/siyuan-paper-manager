import { ATTR } from "../src/constants";
import type { KernelClient } from "../src/core/kernel";
import { LibraryMembershipService } from "../src/services/library-membership";

function setup() {
  const attrs: Record<string, Record<string, string>> = {
    lib: { [ATTR.libraryData]: JSON.stringify({ schemaVersion: 3, avId: "av", avBlockId: "av-block", projectKeyId: "project" }) },
    child: {}, extra: {}, outside: { [ATTR.libraryId]: "lib" },
  };
  let children = [{ id: "child", content: "Same title" }, { id: "extra", content: "Same title" }];
  let values = [
    { blockID: "row-child", block: { id: "child", content: "Different database title" } },
    { blockID: "row-outside", block: { id: "outside", content: "Moved note" } },
    { blockID: "row-gone", block: { id: "gone", content: "Deleted note" } },
  ];
  const kernel = {
    getBlockAttrs: vi.fn(async (id: string) => attrs[id] ?? {}),
    query: vi.fn(async (sql: string) => sql.includes("LIMIT 1")
      ? [{ id: "lib", content: "Library", path: "/lib.sy", box: "box" }] : children),
    getAttributeView: vi.fn(async () => ({ av: { keyValues: [{ key: { type: "block" }, values }] } })),
    getDocumentInfo: vi.fn(async (id: string) => attrs[id] ? { id } : undefined),
    setBlockAttrs: vi.fn(async (id: string, update: Record<string, string>) => { attrs[id] = { ...attrs[id], ...update }; }),
    addAttributeViewBlocks: vi.fn(async (_av: string, _block: string, sources: Array<{ id: string; content: string }>) => {
      values.push(...sources.map(source => ({ blockID: `row-${source.id}`, block: source })));
    }),
    removeAttributeViewBlocks: vi.fn(async (_av: string, ids: string[]) => { values = values.filter(value => !ids.includes(value.blockID)); }),
  };
  return { kernel, attrs, service: new LibraryMembershipService(kernel as unknown as KernelClient),
    setChildren: (next: typeof children) => { children = next; },
    setValues: (next: typeof values) => { values = next; } };
}

it("compares bound document IDs, not titles or metadata, using the complete raw database", async () => {
  const { service, kernel } = setup();
  const scan = await service.scan("lib");
  expect(scan?.differences.map(entry => [entry.kind, entry.docId])).toEqual([
    ["remove", "outside"], ["remove", "gone"], ["add", "extra"],
  ]);
  expect(kernel.query.mock.calls[1]![0]).toContain("instr(substr(path, 6), '/') = 0");
  expect(kernel.addAttributeViewBlocks).not.toHaveBeenCalled();
  expect(kernel.removeAttributeViewBlocks).not.toHaveBeenCalled();
  expect(kernel.setBlockAttrs).not.toHaveBeenCalled();
});

it("applies only selected database changes and clears stale ownership without deleting notes", async () => {
  const { service, kernel, attrs } = setup();
  const scan = (await service.scan("lib"))!;
  const selected = scan.differences.filter(entry => entry.docId !== "gone");
  expect(await service.resolve("lib", selected, "apply")).toEqual({ changed: 2, skipped: 0, failures: [] });
  expect(kernel.removeAttributeViewBlocks).toHaveBeenCalledWith("av", ["row-outside"]);
  expect(kernel.addAttributeViewBlocks).toHaveBeenCalledWith("av", "av-block", [{ id: "extra", content: "Same title" }]);
  expect(attrs.outside![ATTR.libraryId]).toBe("");
  expect(attrs.extra![ATTR.libraryId]).toBe("lib");
  expect((await service.scan("lib"))?.differences.map(entry => entry.docId)).toEqual(["gone"]);
});

it("persists mute on existing notes and uses the library for deleted notes", async () => {
  const { service, attrs, kernel } = setup();
  const scan = (await service.scan("lib"))!;
  await service.resolve("lib", scan.differences, "mute");
  expect(attrs.extra![ATTR.membershipIgnored]).toContain("lib:add:extra:");
  expect(attrs.outside![ATTR.membershipIgnored]).toContain("lib:remove:outside:row-outside");
  expect(attrs.lib![ATTR.membershipIgnored]).toContain("lib:remove:gone:row-gone");
  expect((await new LibraryMembershipService(kernel as unknown as KernelClient).scan("lib"))?.differences).toEqual([]);
  expect(kernel.addAttributeViewBlocks).not.toHaveBeenCalled();
  expect(kernel.removeAttributeViewBlocks).not.toHaveBeenCalled();
});

it("skips stale additions and removals when membership changed after the dialog opened", async () => {
  const { service, setChildren, setValues, kernel } = setup();
  const scan = (await service.scan("lib"))!;
  setChildren([{ id: "child", content: "Child" }, { id: "outside", content: "Returned" }]);
  setValues([{ blockID: "row-child", block: { id: "child", content: "Child" } }]);
  expect(await service.resolve("lib", scan.differences, "apply")).toEqual({ changed: 0, skipped: 3, failures: [] });
  expect(kernel.addAttributeViewBlocks).not.toHaveBeenCalled();
  expect(kernel.removeAttributeViewBlocks).not.toHaveBeenCalled();
});

it("reports unbound database rows as removals and can mute them without a child document", async () => {
  const { service, setChildren, setValues, attrs } = setup();
  setChildren([]);
  setValues([{ blockID: "detached", block: { id: "", content: "Unbound row" } }]);
  const scan = (await service.scan("lib"))!;
  expect(scan.differences).toEqual([{ kind: "remove", docId: "", itemId: "detached", title: "Unbound row" }]);
  await service.resolve("lib", scan.differences, "mute");
  expect(attrs.lib![ATTR.membershipIgnored]).toContain("lib:remove::detached");
});

it("fails closed on unreadable member data and keeps successful selections after a partial error", async () => {
  const { service, kernel } = setup();
  const scan = (await service.scan("lib"))!;
  kernel.removeAttributeViewBlocks.mockRejectedValueOnce(new Error("offline"));
  const result = await service.resolve("lib", scan.differences, "apply");
  expect(result.changed).toBe(2);
  expect(result.failures).toEqual(["Moved note：offline"]);
  kernel.getAttributeView.mockRejectedValue(new Error("unreadable"));
  await expect(service.scan("lib")).rejects.toThrow("unreadable");
});

it("does not scan non-library documents", async () => {
  const { service, kernel } = setup();
  expect(await service.scan("child")).toBeNull();
  expect(kernel.query).not.toHaveBeenCalled();
});
