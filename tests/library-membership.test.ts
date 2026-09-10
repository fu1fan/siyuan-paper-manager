import { ATTR } from "../src/constants";
import type { KernelClient } from "../src/core/kernel";
import type { TemplateService } from "../src/core/templates";
import { LibraryMembershipService } from "../src/services/library-membership";

function setup() {
  const attrs: Record<string, Record<string, string>> = {
    lib: { [ATTR.libraryData]: JSON.stringify({ schemaVersion: 3, avId: "av", avBlockId: "av-block", projectKeyId: "project", fieldKeyIds: { title: "title", citekey: "citekey" } }) },
    child: {}, extra: {}, outside: {},
  };
  const docs = new Map([
    ["lib", { id: "lib", content: "Library", path: "/lib.sy", box: "box", hpath: "/Library" }],
    ["child", { id: "child", content: "Same title", path: "/lib/child.sy", box: "box", hpath: "/Library/Child" }],
    ["extra", { id: "extra", content: "Same title", path: "/lib/extra.sy", box: "box", hpath: "/Library/Extra" }],
    ["nested", { id: "nested", content: "Nested", path: "/lib/extra/nested.sy", box: "box", hpath: "/Library/Extra/Nested" }],
    ["outside", { id: "outside", content: "Outside", path: "/outside.sy", box: "box", hpath: "/Outside" }],
  ]);
  const values = [
    { blockID: "row-child", block: { id: "child", content: "Different database title" } },
    { blockID: "row-outside", block: { id: "outside", content: "Moved note" } },
    { blockID: "row-gone", block: { id: "gone", content: "Deleted note" } },
    { blockID: "row-detached", isDetached: true, block: { id: "", content: "Unbound" } },
  ];
  const metadata = [{ blockID: "row-gone", text: { content: "Database title" } }];
  const kernel = {
    getBlockAttrs: vi.fn(async (id: string) => attrs[id] ?? {}),
    query: vi.fn(async (sql: string) => {
      const id = sql.match(/AND id = '([^']+)'/u)?.[1];
      if (id) return docs.has(id) ? [docs.get(id)!] : [];
      return [...docs.values()].filter(doc => doc.path.startsWith("/lib/")).sort((a,b) => a.id.localeCompare(b.id));
    }),
    getAttributeView: vi.fn(async () => ({ av: { keyValues: [
      { key: { id: "primary", type: "block" }, values },
      { key: { id: "title", type: "text" }, values: metadata },
    ] } })),
    setBlockAttrs: vi.fn(async (id: string, update: Record<string, string>) => { attrs[id] = { ...attrs[id], ...update }; }),
    createDocument: vi.fn(async (_box: string, path: string, _md: string, title: string, options: { id: string }) => {
      docs.set(options.id, { id: options.id, content: title, path: `/lib/${options.id}.sy`, box: "box", hpath: path });
      return { id: options.id };
    }),
    renameDocument: vi.fn(async (id: string, title: string) => { docs.get(id)!.content = title; }),
    parentDocumentId: vi.fn(async (id: string) => docs.get(id)?.path.split("/").at(-2) ?? ""),
    moveDocument: vi.fn(async (id: string) => { docs.get(id)!.path = `/lib/${id}.sy`; }),
    removeDocument: vi.fn(async (_box: string, path: string) => {
      for (const [id, doc] of docs) if (doc.path === path || doc.path.startsWith(path.replace(/\.sy$/, "/"))) docs.delete(id);
    }),
    rebindAttributeViewRow: vi.fn(async (_av: string, _block: string, itemId: string, docId: string) => {
      const value = values.find(value => value.blockID === itemId)!;
      value.block.id = docId; value.isDetached = false;
    }),
  };
  const templates = { ensureSections: vi.fn(async () => ({ meta: "meta" })), refreshMeta: vi.fn() };
  const service = new LibraryMembershipService(kernel as unknown as KernelClient, templates as unknown as TemplateService);
  return { kernel, templates, attrs, docs, values, metadata, service };
}

it("compares IDs only and lists deletion, creation and outside choices without writes", async () => {
  const { service, kernel } = setup();
  const scan = (await service.scan("lib"))!;
  expect(scan.differences.map(e => [e.kind,e.docId])).toEqual([
    ["outside-note","outside"], ["create-note","gone"], ["create-note",""], ["delete-note","extra"],
  ]);
  expect(scan.differences.at(-1)?.descendantIds).toEqual(["nested"]);
  expect(kernel.createDocument).not.toHaveBeenCalled();
  expect(kernel.setBlockAttrs).not.toHaveBeenCalled();
});

it("deletes the selected note subtree, not the database", async () => {
  const { service, docs, values, metadata, kernel } = setup();
  const before = structuredClone({ values, metadata });
  const selected = (await service.scan("lib"))!.differences.filter(e => e.kind === "delete-note");
  expect(await service.resolve("lib", selected, "apply")).toEqual({ changed: 1, skipped: 0, failures: [] });
  expect(docs.has("extra")).toBe(false); expect(docs.has("nested")).toBe(false);
  expect({ values, metadata }).toEqual(before);
  expect(kernel.removeDocument).toHaveBeenCalledWith("box","/lib/extra.sy");
});

it("creates from database metadata and rebinds the original row in place", async () => {
  const { service, kernel, values, metadata, templates } = setup();
  const before = structuredClone(metadata);
  const selected = (await service.scan("lib"))!.differences.filter(e => e.kind === "create-note");
  expect((await service.resolve("lib", selected, "apply")).changed).toBe(2);
  expect(values.map(v => v.blockID)).toEqual(["row-child","row-outside","row-gone","row-detached"]);
  expect(metadata).toEqual(before);
  expect(kernel.rebindAttributeViewRow.mock.calls[0]?.[2]).toBe("row-gone");
  expect(templates.ensureSections).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    canonical: expect.objectContaining({ title: "Database title" }), attachments: [], translation: { mono: undefined, dual: undefined },
  }));
  expect((await service.resolve("lib", selected, "apply")).skipped).toBe(2);
  expect(kernel.createDocument).toHaveBeenCalledTimes(2);
});

it.each(["move", "copy"] as const)("lets the caller choose %s for an outside note", async outsideAction => {
  const { service, kernel, docs, values } = setup();
  const entry = (await service.scan("lib"))!.differences.find(e => e.kind === "outside-note")!;
  expect((await service.resolve("lib", [{ ...entry, outsideAction }], "apply")).changed).toBe(1);
  if (outsideAction === "move") {
    expect(docs.get("outside")?.path).toBe("/lib/outside.sy");
    expect(values[1]!.block.id).toBe("outside"); expect(kernel.createDocument).not.toHaveBeenCalled();
  } else {
    expect(docs.get("outside")?.path).toBe("/outside.sy");
    expect(values[1]!.block.id).not.toBe("outside"); expect(kernel.moveDocument).not.toHaveBeenCalled();
  }
});

it("reuses the preallocated document after a lost creation response", async () => {
  const { service, kernel, attrs } = setup();
  const selected = (await service.scan("lib"))!.differences.filter(e => e.docId === "gone");
  const create = kernel.createDocument.getMockImplementation()!;
  kernel.createDocument.mockImplementationOnce(async (...args) => { await create(...args); throw new Error("lost response"); });
  expect((await service.resolve("lib", selected, "apply")).failures).toHaveLength(1);
  expect(attrs.lib![ATTR.membershipPending]).toContain("row-gone");
  expect((await service.scan("lib"))!.differences.filter(e => e.kind === "delete-note")).toHaveLength(1);
  expect((await service.resolve("lib", selected, "apply")).changed).toBe(1);
  expect(kernel.createDocument).toHaveBeenCalledTimes(1);
});

it("keeps old binding on preparation or binding failure and retries the same document", async () => {
  const { service, kernel, values, templates } = setup();
  const entry = (await service.scan("lib"))!.differences.find(e => e.kind === "outside-note")!;
  templates.refreshMeta.mockRejectedValueOnce(new Error("render failed"));
  expect((await service.resolve("lib", [{ ...entry, outsideAction: "copy" }], "apply")).failures).toHaveLength(1);
  expect(values[1]!.block.id).toBe("outside");
  kernel.rebindAttributeViewRow.mockRejectedValueOnce(new Error("bind failed"));
  expect((await service.resolve("lib", [entry], "apply")).failures).toHaveLength(1);
  expect(values[1]!.block.id).toBe("outside");
  expect((await service.resolve("lib", [entry], "apply")).changed).toBe(1);
  expect(kernel.createDocument).toHaveBeenCalledTimes(1);
});

it("ignores old-direction mute tokens and persists v2 tokens across service instances", async () => {
  const { service, attrs, kernel, templates } = setup();
  attrs.extra![ATTR.membershipIgnored] = '["lib:add:extra:"]';
  const entries = (await service.scan("lib"))!.differences;
  expect(entries.some(e => e.docId === "extra")).toBe(true);
  await service.resolve("lib", entries, "mute");
  expect(attrs.extra![ATTR.membershipIgnored]).toContain("lib:v2:delete-note:extra:");
  expect(attrs.lib![ATTR.membershipIgnored]).toContain("lib:v2:create-note:gone:row-gone");
  const next = new LibraryMembershipService(kernel as unknown as KernelClient, templates as unknown as TemplateService);
  expect((await next.scan("lib"))!.differences).toEqual([]);
  expect(kernel.createDocument).not.toHaveBeenCalled(); expect(kernel.removeDocument).not.toHaveBeenCalled();
});

it("refuses deletion when descendants changed or contain a required member", async () => {
  const { service, docs, values, kernel } = setup();
  const selected = (await service.scan("lib"))!.differences.filter(e => e.kind === "delete-note");
  docs.delete("nested");
  expect((await service.resolve("lib", selected, "apply")).failures[0]).toContain("范围已变化");
  docs.set("child", { ...docs.get("child")!, path: "/lib/extra/child.sy" });
  const changed = (await service.scan("lib"))!.differences.filter(e => e.kind === "delete-note");
  expect(changed[0]?.blockedReason).toContain("数据库成员");
  await service.resolve("lib", changed, "apply");
  expect(kernel.removeDocument).not.toHaveBeenCalled(); expect(values).toHaveLength(4);
});

it("skips a stale deletion after a note has become a database member", async () => {
  const { service, values, kernel } = setup();
  const selected = (await service.scan("lib"))!.differences.filter(e => e.kind === "delete-note");
  values.push({ blockID: "row-extra", block: { id: "extra", content: "Added" } });
  expect((await service.resolve("lib", selected, "apply")).skipped).toBe(1);
  expect(kernel.removeDocument).not.toHaveBeenCalled();
});

it("fails closed when raw membership or pending recovery records cannot be read", async () => {
  const { service, kernel, attrs } = setup();
  kernel.getAttributeView.mockRejectedValueOnce(new Error("unreadable"));
  await expect(service.scan("lib")).rejects.toThrow("unreadable");
  attrs.lib![ATTR.membershipPending] = '[]';
  await expect(service.scan("lib")).rejects.toThrow("恢复记录损坏");
  expect(kernel.removeDocument).not.toHaveBeenCalled();
});
