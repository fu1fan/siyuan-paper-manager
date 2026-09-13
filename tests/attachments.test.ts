import { attachmentState, mergeAttachmentEdit, translationSource } from "../src/services/attachments";
import { paperStateAttrs } from "../src/core/codec";
import { ATTR } from "../src/constants";
import { paper } from "./fixtures";
const pdf = (name: string) => ({ title: `${name}.pdf`, mimeType: "application/pdf", assetAddress: `assets/${name}.pdf`, sha256: name });

it("automatically chooses one PDF but requires designation for multiple originals", () => {
  expect(translationSource(paper({ attachments: [pdf("one")] })).assetAddress).toBe("assets/one.pdf");
  const multiple = paper({ attachments: [pdf("one"), pdf("two")] });
  expect(() => translationSource(multiple)).toThrow("多个 PDF");
  multiple.originalPdf = "assets/two.pdf";
  expect(translationSource(multiple).assetAddress).toBe("assets/two.pdf");
  multiple.originalPdf = "assets/missing.pdf";
  expect(() => translationSource(multiple)).toThrow("已不存在");
});
it("excludes translated PDFs even if duplicated in the attachment list", () => {
  const data = paper({ attachments: [pdf("original"), pdf("mono"), pdf("dual")], translation: { mono: "/assets/mono.pdf", dual: "assets/dual.pdf" } });
  expect(translationSource(data).assetAddress).toBe("assets/original.pdf");
  data.originalPdf = "assets/mono.pdf";
  expect(() => translationSource(data)).toThrow("不是可用 PDF");
});
it("merges renames, removals, translation titles, and source selection without losing concurrent additions", () => {
  const before = paper({ attachments: [pdf("one"), pdf("two")], translation: { mono: "assets/mono.pdf", dual: "assets/dual.pdf" } });
  const draft = attachmentState(before);
  draft.attachments[0]!.title = "论文原稿";
  draft.attachments.splice(1, 1);
  draft.originalPdf = "assets/one.pdf";
  draft.translation.monoTitle = "中文译稿";
  delete draft.translation.dual;
  const latest = paper({ ...before, attachments: [...before.attachments, { ...pdf("snapshot"), mimeType: "text/html" }], canonical: { ...before.canonical, title: "Concurrent title" } });
  const result = mergeAttachmentEdit(latest, before, draft);
  expect(result.attachments.map(item => item.title)).toEqual(["论文原稿", "snapshot.pdf"]);
  expect(result.canonical.title).toBe("Concurrent title");
  expect(result.originalPdf).toBe("assets/one.pdf");
  expect(result.translation).toMatchObject({ monoTitle: "中文译稿", dual: undefined });
  expect(latest.attachments[0]!.title).toBe("one.pdf");
  expect(paperStateAttrs(result)).toMatchObject({ [ATTR.originalPdf]: "assets/one.pdf", [ATTR.translationMonoTitle]: "中文译稿", [ATTR.translationDual]: "" });
});
it("preserves a newly completed translation when it was not edited", () => {
  const before = paper({ attachments: [pdf("one")] });
  const draft = attachmentState(before); draft.attachments[0]!.title = "Renamed";
  const latest = paper({ ...before, translation: { mono: "assets/new.pdf", monoTitle: "New" } });
  expect(mergeAttachmentEdit(latest, before, draft).translation).toEqual(latest.translation);
});
it("rejects stale translation deletions and concurrent author-selected originals", () => {
  const before = paper({ attachments: [pdf("one"), pdf("two")], translation: { mono: "assets/old.pdf" } });
  const draft = attachmentState(before); delete draft.translation.mono;
  expect(() => mergeAttachmentEdit(paper({ ...before, translation: { mono: "assets/new.pdf" } }), before, draft)).toThrow("翻译附件已");
  draft.translation.mono = before.translation.mono; draft.originalPdf = "assets/one.pdf";
  expect(() => mergeAttachmentEdit(paper({ ...before, originalPdf: "assets/two.pdf" }), before, draft)).toThrow("论文原稿已");
});
it("clears a deleted original, accepts retries, and rejects stale renames", () => {
  const before = paper({ attachments: [pdf("one"), pdf("two")], originalPdf: "assets/one.pdf" });
  const draft = attachmentState(before); draft.attachments.shift(); draft.originalPdf = undefined;
  const result = mergeAttachmentEdit(before, before, draft);
  expect(result.originalPdf).toBeUndefined();
  expect(mergeAttachmentEdit(result, before, draft)).toEqual(result);
  const renamed = attachmentState(before); renamed.attachments[0]!.title = "Changed";
  expect(() => mergeAttachmentEdit(result, before, renamed)).toThrow("附件已");
});
it("does not treat a renamed HTML snapshot as a PDF, and keeps pending PDFs distinct from pending translations", () => {
  expect(() => translationSource(paper({ attachments: [{ title: "fake.pdf", mimeType: "text/html", assetAddress: "assets/snapshot.html", sha256: "html" }] }))).toThrow("没有可翻译");
  expect(translationSource(paper({ attachments: [{ ...pdf("one"), assetAddress: "pending:1" }], translation: { mono: "pending:2" } })).assetAddress).toBe("pending:1");
});
