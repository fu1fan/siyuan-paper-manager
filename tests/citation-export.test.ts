import { exportCitations, latex } from "../src/services/citation-export";
import { paper } from "./fixtures";

describe("citation export", () => {
  it("exports standards, BibTeX, BibLaTeX and Hayagriva deterministically", () => {
    const input = paper({ canonical: { ...paper().canonical, publisher: "测试出版社", pages: "1-10" } });
    const gbt = exportCitations([input], "gbt-numeric");
    expect(gbt.content).toContain("[1] 张 三. 示例论文 Example Paper[J]");
    const bib = exportCitations([input], "bibtex");
    expect(bib.extension).toBe("bib");
    expect(bib.content).toContain("@article{张2026示例论文");
    expect(exportCitations([input], "biblatex").content).toContain("journaltitle");
    expect(exportCitations([input], "hayagriva").content).toContain("type: \"article\"");
  });

  it("exports LaTeX and Typst cite syntax and warns on missing fields", () => {
    const sparse = paper({ canonical: { itemType: "journalArticle", title: "A & B", creators: [], tags: [] } });
    expect(exportCitations([sparse], "latex-parencite").content).toBe("\\parencite{张2026示例论文}");
    expect(exportCitations([sparse], "typst-cite").content).toBe("#cite(<张2026示例论文>)");
    expect(exportCitations([sparse], "apa7").warnings[0]).toMatch(/作者/);
    expect(latex("A & B_1")).toBe("A \\& B\\_1");
  });
});
