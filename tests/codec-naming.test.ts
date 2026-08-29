import { decodePaperData, encodePaperData, paperIndexAttrs } from "../src/core/codec";
import { generateCitekey, normalizeDoi, sanitizeDocumentName, titleSimilarity, uniqueCitekey } from "../src/core/naming";
import { ATTR } from "../src/constants";
import { paper } from "./fixtures";

describe("paper codec and naming", () => {
  it("round-trips UTF-8 metadata through base64", () => {
    const input = paper();
    expect(decodePaperData(encodePaperData(input))).toEqual(input);
  });

  it("rejects unsupported schema versions", () => {
    const encoded = btoa(JSON.stringify({ schemaVersion: 99, canonical: { title: "x" } }));
    expect(() => decodePaperData(encoded)).toThrow(/schemaVersion/);
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

  it("keeps index attributes synchronized", () => {
    const data = paper({
      attachments: [{ title: "PDF", mimeType: "application/pdf", assetAddress: "assets/paper.pdf", sha256: "abc" }],
      translation: { mono: "assets/mono.pdf" },
    });
    const attrs = paperIndexAttrs(data);
    expect(attrs[ATTR.doi]).toBe("10.1234/example");
    expect(attrs[ATTR.attachmentPdf]).toBe("assets/paper.pdf");
    expect(attrs[ATTR.translationMono]).toBe("assets/mono.pdf");
  });
});
