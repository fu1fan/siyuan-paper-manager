import { findCanonicalConflicts, mergePaperData } from "../src/core/merge";
import { normalizeSettings, splitArgString } from "../src/types/settings";
import { paper } from "./fixtures";

describe("merge policy", () => {
  it("fills empty fields and preserves existing conflicts by default", () => {
    const existing = paper();
    delete existing.canonical.publisher;
    const incoming = paper({
      canonical: { ...paper().canonical, title: "传入标题", publisher: "出版社" },
      attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/a.pdf", sha256: "a" }],
    });
    const merged = mergePaperData(existing, incoming, []);
    expect(merged.canonical.title).toBe("示例论文 Example Paper");
    expect(merged.canonical.publisher).toBe("出版社");
    expect(merged.attachments).toHaveLength(1);
    expect(merged.sources).toHaveLength(2);
  });

  it("overwrites only explicitly selected conflict fields", () => {
    const existing = paper();
    const incoming = paper({ canonical: { ...paper().canonical, title: "新标题", date: "2027" } });
    const merged = mergePaperData(existing, incoming, ["title"]);
    expect(merged.canonical.title).toBe("新标题");
    expect(merged.canonical.date).toBe("2026");
    expect(findCanonicalConflicts(existing.canonical, incoming.canonical).map((item) => item.field)).toEqual(expect.arrayContaining(["title", "date"]));
  });

  it("deduplicates attachments by sha256", () => {
    const attachment = { title: "PDF", mimeType: "application/pdf", assetAddress: "assets/a.pdf", sha256: "same" };
    const merged = mergePaperData(paper({ attachments: [attachment] }), paper({ attachments: [{ ...attachment, assetAddress: "assets/b.pdf" }] }), []);
    expect(merged.attachments).toHaveLength(1);
  });
});

describe("settings", () => {
  it("migrates string CLI args and normalizes asset paths", () => {
    const settings = normalizeSettings({
      pdf2zhArgs: "-t 4 --config 'my file.json'",
      assetsDir: "assets/library",
    });
    expect(settings.pdf2zhArgs).toEqual(["-t", "4", "--config", "my file.json"]);
    expect(settings.assetsDir).toBe("/assets/library/");
  });

  it("parses escaped argument strings without shell execution", () => {
    expect(splitArgString("--foo \\\"bar baz\\\" -t 2")).toEqual(["--foo", '"bar', 'baz"', "-t", "2"]);
    expect(splitArgString('--foo "bar baz" -t 2')).toEqual(["--foo", "bar baz", "-t", "2"]);
  });
});
