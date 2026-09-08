/** Small valid, text-based PDF with an embedded ToUnicode map; no external fonts needed for extraction. */
export function chinesePdf(useCmap = false): Uint8Array {
  const title = "基于深度学习的状态估计方法";
  const second = "及其在机器人控制中的应用";
  const texts = ["自动化学报", title, second, "欧阳明；单伟", "摘要：本文提出一种状态估计方法。", "关键词：机器人；深度学习", "DOI: 10.1234/example.2026"];
  const hex = (value: string) => Buffer.from(value, "utf16le").swap16().toString("hex").toUpperCase();
  const chars = [...new Set(texts.join(""))];
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map((c) => `<${hex(c)}> <${hex(c)}>`).join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const contents = texts.map((text, i) => `BT /F1 ${i === 1 || i === 2 ? 22 : 11} Tf 1 0 0 1 55 ${780 - i * 38} Tm <${hex(text)}> Tj ET`).join("\n");
  const stream = (value: string) => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    useCmap ? "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>" : "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>",
    useCmap ? "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 9 0 R >>" : "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /FontDescriptor 9 0 R >>",
    stream(contents), stream(cmap),
    `<< /Title (Microsoft Word - draft.docx) /Author <FEFF${hex("欧阳明；单伟")}> /CreationDate (D:20260908000000) >>`,
    "<< /Type /FontDescriptor /FontName /Test /Flags 4 /FontBBox [0 -200 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
