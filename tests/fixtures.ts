import type { PaperData } from "../src/types/paper";

export function paper(overrides: Partial<PaperData> = {}): PaperData {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    schemaVersion: 1,
    canonical: {
      itemType: "journalArticle",
      title: "示例论文 Example Paper",
      creators: [{ family: "张", given: "三", creatorType: "author" }],
      date: "2026",
      doi: "10.1234/example",
      journal: "Example Journal",
      abstract: "摘要内容",
      tags: ["测试", "paper"],
    },
    sources: [{ source: "pdf-import", importedAt: now, raw: { title: "示例论文 Example Paper" } }],
    attachments: [],
    translation: {},
    citekey: "张2026示例论文",
    source: "pdf-import",
    importedAt: now,
    updatedAt: now,
    ...overrides,
  };
}
