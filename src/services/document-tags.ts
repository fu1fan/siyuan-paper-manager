import { ATTR } from "../constants";
import { decodeLibraryData } from "../core/codec";
import type { KernelClient } from "../core/kernel";

/** Native document tags are separate from the paper database's keyword column. */
export async function applyDocumentTag(kernel: KernelClient, docId: string, next: string): Promise<void> {
  const attrs = await kernel.getBlockAttrs(docId);
  const previous = attrs[ATTR.defaultDocumentTag] || "";
  const tags = (attrs.tags || "").split(",").map(tag => tag.trim()).filter(Boolean);
  const updated = tags.filter(tag => !previous || tag !== previous);
  if (next && !updated.includes(next)) updated.push(next);
  if (previous === next && tags.join(",") === updated.join(",")) return;
  // One attribute write keeps the managed-tag marker consistent for failed-save retries.
  await kernel.setBlockAttrs(docId, { tags: updated.join(","), [ATTR.defaultDocumentTag]: next });
}

export async function syncDocumentTags(kernel: KernelClient, next: string): Promise<void> {
  const ids = new Set<string>();
  const libraries: string[] = [];
  // Explicit pagination avoids SiYuan's default SQL result limit.
  for (let offset = 0; ; offset += 500) {
    const rows = await kernel.query(`SELECT b.id, a.name, a.value FROM blocks b JOIN attributes a ON a.block_id = b.id WHERE b.type = 'd' AND a.name IN ('${ATTR.libraryId}', '${ATTR.libraryData}', '${ATTR.defaultDocumentTag}') ORDER BY b.id, a.name LIMIT 500 OFFSET ${offset}`);
    for (const row of rows) {
      if (row.name === ATTR.libraryData) libraries.push(String(row.value));
      else ids.add(String(row.id));
    }
    if (rows.length < 500) break;
  }
  // Include database-bound documents even when they lack plugin machine attributes.
  for (const raw of libraries) {
    const { avId } = decodeLibraryData(raw);
    const primary = (await kernel.getAttributeView(avId)).av.keyValues.find(({ key }) => key.type === "block");
    if (!primary || (primary.values != null && !Array.isArray(primary.values))) throw new Error("无法读取文献库成员，标签同步未完成");
    for (const value of primary.values ?? []) {
      const id = value.isDetached ? "" : value.block?.id;
      if (id) ids.add(id);
    }
  }
  const failures: string[] = [];
  for (const id of ids) {
    try {
      const docs = await kernel.query(`SELECT id FROM blocks WHERE type = 'd' AND id = '${id.replaceAll("'", "''")}' LIMIT 1`);
      if (!docs.length) continue; // Missing notes are handled by membership synchronization.
      await applyDocumentTag(kernel, id, next);
    } catch (error) { failures.push(`${id}：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`设置已保存，但 ${failures.length} 篇文档标签未同步；再次保存可重试。${failures.slice(0, 3).join("；")}`);
}
