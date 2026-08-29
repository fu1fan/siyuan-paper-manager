import { decodeLegacyPaperData, paperStateAttrs } from "../src/core/codec";
import { generateCitekey, normalizeDoi, sanitizeDocumentName, titleSimilarity, uniqueCitekey } from "../src/core/naming";
import { ATTR } from "../src/constants";
import { paper } from "./fixtures";

/** 与旧版 encodePaperData 等价的测试编码器（UTF-8 安全）。 */
function legacyEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

describe("paper codec and naming", () => {
  it("decodes legacy base64 paper data for one-time migration", () => {
    const legacy = decodeLegacyPaperData(legacyEncode({
      schemaVersion: 3,
      canonical: paper().canonical,
      citekey: "张2026示例论文",
      libraryId: "library-doc",
      attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/paper.pdf", sha256: "abc" }],
      translation: { mono: "assets/mono.pdf" },
    }));
    expect(legacy.citekey).toBe("张2026示例论文");
    expect(legacy.libraryId).toBe("library-doc");
    expect(legacy.attachments[0]?.assetAddress).toBe("assets/paper.pdf");
    expect(legacy.translation.mono).toBe("assets/mono.pdf");
    expect(legacy.projectIds).toEqual([]);
  });

  it("reads schema v2 project assignments during migration", () => {
    const legacy = decodeLegacyPaperData(legacyEncode({
      schemaVersion: 2,
      canonical: paper().canonical,
      citekey: "ck",
      libraryId: "library-doc",
      projectIds: ["p1", 2, "p2"],
    }));
    expect(legacy.projectIds).toEqual(["p1", "p2"]);
  });

  it("rejects unsupported legacy schema versions", () => {
    const encoded = btoa(JSON.stringify({ schemaVersion: 99, canonical: { title: "x" } }));
    expect(() => decodeLegacyPaperData(encoded)).toThrow(/schemaVersion/);
  });

  it("normalizes DOI URLs and trailing punctuation", () => {
    expect(normalizeDoi("https://doi.org/10.1000/ABC.123).")) .toBe("10.1000/abc.123");
    expect(normalizeDoi("not a DOI")).toBeUndefined();
  });

  it("creates safe document names and deterministic citekeys", () => {
    expect(sanitizeDocumentName("a/b:c*? d")).toBe("a b c d");
    expect(generateCitekey(paper().canonical)).toContain("2026");
  });

  it("compares normalized multilingual titles", () => {
    expect(titleSimilarity("A Study: of Tests", "A study of tests")).toBeGreaterThan(0.95);
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
    expect(Object.keys(attrs)).toHaveLength(6);
  });
});
