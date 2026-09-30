import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { parseFontNames, scanSystemFonts, systemFontDirectories } from "../src/services/system-fonts";

function nameTable(): Buffer {
  const records = [
    { id: 1, lang: 0x409, text: "Example Serif" },
    { id: 4, lang: 0x409, text: "Example Serif Regular" },
    { id: 4, lang: 0x804, text: "示例宋体" },
    { id: 6, lang: 0x409, text: "ＥｘａｍｐｌｅＳｅｒｉｆ-Regular" },
  ];
  const encoded = records.map(record => Buffer.from(record.text, "utf16le").swap16());
  const stringsOffset = 6 + records.length * 12;
  const bytes = Buffer.alloc(stringsOffset + encoded.reduce((size, data) => size + data.length, 0));
  bytes.writeUInt16BE(records.length, 2);
  bytes.writeUInt16BE(stringsOffset, 4);
  let position = 0;
  records.forEach((record, index) => {
    const offset = 6 + index * 12;
    bytes.writeUInt16BE(3, offset);
    bytes.writeUInt16BE(1, offset + 2);
    bytes.writeUInt16BE(record.lang, offset + 4);
    bytes.writeUInt16BE(record.id, offset + 6);
    bytes.writeUInt16BE(encoded[index]!.length, offset + 8);
    bytes.writeUInt16BE(position, offset + 10);
    encoded[index]!.copy(bytes, stringsOffset + position);
    position += encoded[index]!.length;
  });
  return bytes;
}

function fontFile(collection = false): Buffer {
  const names = nameTable();
  const sfnt = collection ? 16 : 0;
  const bytes = Buffer.alloc(sfnt + 28 + names.length);
  if (collection) {
    bytes.write("ttcf");
    bytes.writeUInt32BE(0x00010000, 4);
    bytes.writeUInt32BE(1, 8);
    bytes.writeUInt32BE(sfnt, 12);
  }
  bytes.writeUInt32BE(0x00010000, sfnt);
  bytes.writeUInt16BE(1, sfnt + 4);
  bytes.write("name", sfnt + 12);
  bytes.writeUInt32BE(sfnt + 28, sfnt + 20);
  bytes.writeUInt32BE(names.length, sfnt + 24);
  names.copy(bytes, sfnt + 28);
  return bytes;
}

it("uses localized font labels and the exact PostScript name for preview", () => {
  expect(parseFontNames(nameTable())).toEqual({ name: "示例宋体", family: "Example Serif", postscriptName: "ExampleSerif-Regular" });
  expect(parseFontNames(new Uint8Array([0, 1]))).toBeNull();
  expect(parseFontNames(nameTable().subarray(0, 32))).toBeNull();
});

it("scans nested installed files and the first TTC face, skipping corrupt files and duplicate directories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-fonts-"));
  try {
    mkdirSync(join(directory, "nested"));
    const ttf = join(directory, "nested", "example.TTF");
    const ttc = join(directory, "example.ttc");
    writeFileSync(ttf, fontFile());
    writeFileSync(ttc, fontFile(true));
    writeFileSync(join(directory, "bad.otf"), "not a font");
    const invalid = fontFile();
    invalid.writeUInt32BE(0xffffffff, 20);
    writeFileSync(join(directory, "invalid.ttf"), invalid);
    const fonts = await scanSystemFonts(createRequire(import.meta.url), [directory, directory, join(directory, "missing")]);
    expect(fonts.map(font => font.path).sort()).toEqual([ttc, ttf].map(file => realpathSync(file)).sort());
    expect(fonts.every(font => font.name === "示例宋体")).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("includes system and user font locations on macOS, Windows and Linux", () => {
  expect(systemFontDirectories("darwin", "/Users/test", join, {})).toEqual([
    "/Users/test/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts",
  ]);
  expect(systemFontDirectories("win32", "C:\\Users\\test", win32.join, { WINDIR: "D:\\Windows", LOCALAPPDATA: "C:\\Local" })).toEqual([
    "D:\\Windows\\Fonts", "C:\\Local\\Microsoft\\Windows\\Fonts",
  ]);
  expect(systemFontDirectories("win32", "C:\\Users\\test", win32.join, {})).toContain("C:\\Users\\test\\AppData\\Local\\Microsoft\\Windows\\Fonts");
  expect(systemFontDirectories("linux", "/home/test", join, {})).toEqual([
    "/home/test/.local/share/fonts", "/home/test/.fonts", "/usr/local/share/fonts", "/usr/share/fonts",
  ]);
});
