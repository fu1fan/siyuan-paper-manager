import { paperStateAttrs } from "../src/core/codec";
import { generateCitekey, normalizeDoi, sanitizeDocumentName, titleSimilarity, uniqueCitekey } from "../src/core/naming";
import { ATTR } from "../src/constants";
import { paper } from "./fixtures";

describe("paper state attrs and naming", () => {
  it("normalizes DOI URLs and trailing punctuation", () => {
    expect(normalizeDoi("https://doi.org/10.1000/ABC.123).")) .toBe("10.1000/abc.123");
    expect(normalizeDoi("not a DOI")).toBeUndefined();
  });

  it("creates safe document names and deterministic citekeys", () => {
    expect(sanitizeDocumentName("a/b:c*? d")).toBe("a b c d");
    expect(sanitizeDocumentName("a[b]c")).toBe("a b c");
    expect(sanitizeDocumentName("report.")).toBe("report");
    expect(sanitizeDocumentName("   ")).toBe("未命名文献");
    expect(sanitizeDocumentName("x".repeat(200))).toHaveLength(120);
    expect(generateCitekey(paper().canonical)).toContain("2026");
  });

  it("compares normalized multilingual titles", () => {
    expect(titleSimilarity("A Study: of Tests", "A study of tests")).toBeGreaterThan(0.95);
    // Unrelated titles must score low; the duplicate threshold is 0.92.
    expect(titleSimilarity("Deep Learning for Vision", "Quantum Chemistry of Solids")).toBeLessThan(0.3);
    expect(titleSimilarity("基于深度学习的状态估计", "基于深度学习的状态估计")).toBe(1);
    expect(titleSimilarity("", "anything")).toBe(0);
  });

  it("adds stable suffixes to duplicate citekeys", () => {
    expect(uniqueCitekey("smith2026paper", ["smith2026paper", "smith2026papera"]))
      .toBe("smith2026paperb");
  });

  it("writes only machine-state attributes for paper documents", () => {
    const data = paper({
      attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/paper.pdf", sha256: "abc" }],
      translation: { mono: "assets/mono.pdf" },
    });
    const attrs = paperStateAttrs(data);
    expect(JSON.parse(attrs[ATTR.attachments]!)).toEqual(data.attachments);
    expect(attrs[ATTR.translationMono]).toBe("assets/mono.pdf");
    expect(attrs[ATTR.state]).toBe("ready");
    expect(attrs[ATTR.libraryId]).toBe("library-doc");
    expect(attrs[ATTR.originalPdf]).toBe("");
    expect(attrs[ATTR.translationMonoTitle]).toBe("");
    expect(attrs[ATTR.translationDualTitle]).toBe("");
    expect(Object.keys(attrs)).toHaveLength(9);
  });
});

describe("stored JSON escaping", () => {
  it("preserves literal HTML entities in ordinary JSON", async () => {
    const { parseStoredJson } = await import("../src/core/codec");
    expect(parseStoredJson('{"title":"Use &quot;quotes&quot; &amp; symbols"}'))
      .toEqual({ title: "Use &quot;quotes&quot; &amp; symbols" });
  });

  it("decodes HTML-escaped attribute JSON", async () => {
    const { parseStoredJson } = await import("../src/core/codec");
    expect(parseStoredJson('{&quot;title&quot;:&quot;A &amp; B&quot;}')).toEqual({ title: "A & B" });
  });
});
