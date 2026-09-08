import { findCanonicalConflicts, mergePaperData } from "../src/core/merge";
import { normalizeSettings, serializeArgs, splitArgString } from "../src/types/settings";
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
    expect(merged.citekey).toBe(existing.citekey);
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
    expect(settings.pdf2zhArgs).toEqual(["--config", "my file.json"]);
    expect(settings.translationThreads).toBe(4);
    expect(settings.assetsDir).toBe("/assets/library/");
    expect(settings.autoDeleteOldTranslations).toBe(false);
  });

  it("loads the optional old translation cleanup setting", () => {
    expect(normalizeSettings({ autoDeleteOldTranslations: true }).autoDeleteOldTranslations).toBe(true);
  });

  it("parses escaped argument strings without shell execution", () => {
    expect(splitArgString("--foo \\\"bar baz\\\" -t 2")).toEqual(["--foo", '"bar', 'baz"', "-t", "2"]);
    expect(splitArgString('--foo "bar baz" -t 2')).toEqual(["--foo", "bar baz", "-t", "2"]);
  });
});

it("preserves Windows paths and round-trips editable arguments", () => {
  const args = ["--config", String.raw`C:\Users\中文 User\config.json`, "C:/Users/Alice/a.json",
    String.raw`\\server\共享\file.pdf`, "", 'a"b', "single'quote", "end\\", "two\\\\", "a\\\"b"];
  expect(splitArgString(serializeArgs(args))).toEqual(args);
  expect(splitArgString(String.raw`--config "C:\Users\Alice\config.json"`))
    .toEqual(["--config", String.raw`C:\Users\Alice\config.json`]);
  expect(splitArgString(String.raw`--config '\\server\共享 folder\'`))
    .toEqual(["--config", "\\\\server\\共享 folder\\"]);
  expect(splitArgString(`"" ''`)).toEqual(["", ""]);
});

it("migrates and bounds translation concurrency while preserving custom services", () => {
  expect(normalizeSettings({}).translationConcurrency).toBe(1);
  expect(normalizeSettings({ translationConcurrency: 3.8 }).translationConcurrency).toBe(3);
  expect(normalizeSettings({ translationConcurrency: 100 }).translationConcurrency).toBe(8);
  expect(normalizeSettings({ translationConcurrency: "invalid" }).translationConcurrency).toBe(1);
  expect(normalizeSettings({ translateService: "openai:custom-model" }).translateService).toBe("openai:custom-model");
});

it.each(["-t 9", "--thread 9", "--thread=9", "-t9", "-t=9"])("migrates legacy thread option %s", (flag) => {
  const result = normalizeSettings({ pdf2zhArgs: `${flag} --config 'my config.json'` });
  expect(result.translationThreads).toBe(9);
  expect(result.pdf2zhArgs).toEqual(["--config", "my config.json"]);
});

it("gives the dedicated request concurrency setting precedence and validates it independently", () => {
  expect(normalizeSettings({}).translationThreads).toBe(4);
  expect(normalizeSettings({ translationThreads: 0 }).translationThreads).toBe(4);
  expect(normalizeSettings({ translationThreads: 1000 }).translationThreads).toBe(128);
  const result = normalizeSettings({ translationThreads: 6, translationConcurrency: 2, pdf2zhArgs: ["-t", "3", "--thread=12", "--", "-t9"] });
  expect(result.translationThreads).toBe(6);
  expect(result.translationConcurrency).toBe(2);
  expect(result.pdf2zhArgs).toEqual(["--", "-t9"]);
});
