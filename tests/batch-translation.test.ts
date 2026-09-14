import { matchesTranslationPaper, translationBlockReason } from "../src/services/batch-translation";
import { TranslatorService } from "../src/services/translator";
import type { KernelClient } from "../src/core/kernel";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { paper } from "./fixtures";

const pdf = { title: "原稿", mimeType: "application/pdf", assetAddress: "assets/original.pdf", sha256: "x" };
const record = () => ({ docId: "doc", paper: paper({ attachments: [pdf] }), projectNames: ["手动项目"], notes: "HBM 带宽瓶颈" });
it("searches notes, abstracts and metadata together with native project values", () => {
  expect(matchesTranslationPaper(record(), "hbm 瓶颈", "project:手动项目")).toBe(true);
  expect(matchesTranslationPaper(record(), "摘要", "")).toBe(true);
  expect(matchesTranslationPaper(record(), "2026 张", "project:其他")).toBe(false);
  expect(matchesTranslationPaper(record(), "", "unassigned")).toBe(false);
  expect(matchesTranslationPaper({ ...record(), projectNames: [] }, "", "unassigned")).toBe(true);
});
it("blocks translated, missing, ambiguous and unreadable attachments", () => {
  expect(translationBlockReason(record())).toBeUndefined();
  expect(translationBlockReason({ ...record(), loadError: "无法读取" })).toBe("无法读取");
  for (const kind of ["mono", "dual"]) expect(translationBlockReason({ ...record(), paper: paper({ translation: { [kind]: "assets/translated.pdf" } }) })).toBe("已有译文");
  expect(translationBlockReason({ ...record(), paper: paper() })).toContain("没有可翻译");
  const multiple = paper({ attachments: [pdf, { ...pdf, assetAddress: "assets/supplement.pdf" }] });
  expect(translationBlockReason({ ...record(), paper: multiple })).toContain("多个 PDF");
  expect(translationBlockReason({ ...record(), paper: { ...multiple, originalPdf: pdf.assetAddress } })).toBeUndefined();
});
it("exposes running and queued membership, rejects duplicates and rechecks translations at execution", async () => {
  let release!: (value: ReturnType<typeof paper>) => void;
  const first = new Promise<ReturnType<typeof paper>>(resolve => { release = resolve; });
  const readPaper = vi.fn((id: string) => id === "first" ? first : Promise.resolve(paper({ translation: { dual: "assets/translated.pdf" } })));
  const spawnProcess = vi.fn();
  const translator = new TranslatorService({} as KernelClient, { requireFn: vi.fn(), readPaper, persist: vi.fn(), spawnProcess });
  const a = translator.translate("first", DEFAULT_SETTINGS, { untranslatedOnly: true }).catch(error => error.message);
  const b = translator.translate("second", DEFAULT_SETTINGS, { untranslatedOnly: true }).catch(error => error.message);
  expect(translator.taskState("first")).toBe("running");
  expect(translator.taskState("second")).toBe("queued");
  await expect(translator.translate("second", DEFAULT_SETTINGS)).rejects.toThrow("已在翻译队列");
  release(paper({ translation: { mono: "assets/new.pdf" } }));
  expect(await a).toContain("已有译文");
  expect(await b).toContain("已有译文");
  expect(translator.taskState("first")).toBeUndefined();
  expect(translator.taskState("second")).toBeUndefined();
  expect(spawnProcess).not.toHaveBeenCalled();
});
