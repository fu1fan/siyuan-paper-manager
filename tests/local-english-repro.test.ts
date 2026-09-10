import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MetadataExtractor } from "../src/services/metadata-extractor";

// Opt-in live integration check; no personal paths or network access in the default suite.
const path = process.env.PAPER_MANAGER_TEST_PDF;
it.skipIf(!path)("recognizes the supplied AlpaServe PDF with live services", async () => {
  const bytes = new Uint8Array(readFileSync(path!));
  const result = await new MetadataExtractor({
    enableZoteroRecognizer: process.env.PAPER_MANAGER_TEST_ZOTERO === "1",
    pdfOptions: { cMapUrl: resolve("node_modules/pdfjs-dist/cmaps") + "/", cMapPacked: true, standardFontDataUrl: resolve("node_modules/pdfjs-dist/standard_fonts") + "/" },
  }).extract(bytes, "lialpaserve2023.pdf");
  expect(result.selected.canonical.title).toContain("AlpaServe:");
  expect(result.selected.canonical.creators).toHaveLength(11);
  console.info({ providers: result.candidates.map(candidate => candidate.provider), warnings: result.warnings });
}, 120_000);
