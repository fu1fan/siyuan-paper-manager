import type { PaperData } from "../src/types/paper";

export function paper(overrides: Partial<PaperData> = {}): PaperData {
  return {
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
    attachments: [],
    translation: {},
    citekey: "张2026示例论文",
    libraryId: "library-doc",
    ...overrides,
  };
}
