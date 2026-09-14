import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { KernelClient } from "../src/core/kernel";
import type { TranslationState } from "../src/types/status";
import { TranslatorService } from "../src/services/translator";
import { translationStatusView } from "../src/ui/statusbar";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { paper } from "./fixtures";

it("keeps concurrent stdout percentages separate and remembers failures after the last success", async () => {
  const root = mkdtempSync(join(tmpdir(), "paper-progress-"));
  mkdirSync(join(root, "data/assets"), { recursive: true });
  writeFileSync(join(root, "data/assets/input.pdf"), "%PDF-1.4\n");
  const children: Array<{ child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }; output: string }> = [];
  const states: TranslationState[] = [];
  const input = paper({ attachments: [{ title: "原稿", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "x" }] });
  const translator = new TranslatorService({
    getWorkspaceInfo: async () => ({ workspaceDir: root }),
    uploadAsset: async () => "assets/result.pdf",
  } as unknown as KernelClient, {
    requireFn: createRequire(import.meta.url), readPaper: async id => ({ ...input, canonical: { ...input.canonical, title: id } }),
    persist: vi.fn(), onState: state => states.push(state),
    spawnProcess: (_exe, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      children.push({ child, output: args[args.indexOf("-o") + 1]! });
      return child as unknown as ChildProcess;
    },
  });
  const settings = { ...DEFAULT_SETTINGS, pdf2zhPath: process.execPath, translationConcurrency: 2, autoDeleteOldTranslations: false };
  try {
    const jobs = ["论文 A", "论文 B", "论文 C"].map(id => translator.translate(id, settings));
    const outcomes = Promise.allSettled(jobs);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0]!.child.stdout.write("80%\n");
    children[1]!.child.stderr.write("10%\n");
    children[0]!.child.stderr.write("ordinary log without percentage\n");
    const state = states.at(-1)!;
    expect(state).toMatchObject({ state: "running", docId: "论文 A", progress: 80, batch: {
      total: 3, tasks: [{ docId: "论文 A", progress: 80 }, { docId: "论文 B", progress: 10 }],
    } });
    expect(translationStatusView(state)).toMatchObject({ percent: 0, label: "翻译 · 已处理 0/3 · 进行 2 · 等待 1" });
    expect(translationStatusView(state).title).toContain("论文 A：80%");
    expect(translationStatusView(state).title).toContain("论文 B：10%");
    children[0]!.child.emit("close", 1, null);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    expect(states.at(-1)).toMatchObject({ batch: { failed: 1, total: 3 } });
    expect(translationStatusView(states.at(-1)!).label).toContain("已处理 1/3");
    for (const { child, output } of children.slice(1)) {
      writeFileSync(join(output, "input-mono.pdf"), "%PDF-1.4\n");
      child.emit("close", 0, null);
    }
    expect((await outcomes).map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(states.at(-1)).toMatchObject({ state: "error", batch: { total: 3, succeeded: 2, failed: 1, cancelled: 0, tasks: [] } });
    expect(translationStatusView(states.at(-1)!).label).toContain("成功 2 · 失败 1");
    expect(translationStatusView(states.at(-1)!).title).toContain("论文 A");
    const next = translator.translate("新一批", settings);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    expect(states.at(-1)).toMatchObject({ batch: { total: 1, succeeded: 0, failed: 0, cancelled: 0 } });
    const outcome = next.catch(() => {});
    children[3]!.child.emit("close", 1, null);
    await outcome;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("retains single-paper percentage and distinguishes saving from completion", () => {
  expect(translationStatusView({ state: "running", docId: "a", progress: 65 }).label).toBe("翻译中 65%");
  expect(translationStatusView({ state: "running", docId: "a", progress: 100, message: "正在保存译稿" })).toMatchObject({
    label: "翻译 · 正在保存译稿", percent: undefined,
  });
});

it("counts cancelled waiting and active papers in the batch summary", async () => {
  let resolve!: (value: ReturnType<typeof paper>) => void;
  const pending = new Promise<ReturnType<typeof paper>>(done => { resolve = done; });
  const states: TranslationState[] = [];
  const translator = new TranslatorService({} as KernelClient, {
    requireFn: createRequire(import.meta.url), readPaper: () => pending, persist: vi.fn(), onState: state => states.push(state),
  });
  const outcomes = Promise.allSettled([translator.translate("one", DEFAULT_SETTINGS), translator.translate("two", DEFAULT_SETTINGS)]);
  translator.cancel();
  expect(states.at(-1)).toMatchObject({ state: "running", queued: 0, batch: { cancelled: 1, total: 2 } });
  resolve(paper());
  await outcomes;
  expect(states.at(-1)).toMatchObject({ state: "error", batch: { cancelled: 2, failed: 0, total: 2 } });
  expect(translationStatusView(states.at(-1)!).label).toContain("取消 2");
});
