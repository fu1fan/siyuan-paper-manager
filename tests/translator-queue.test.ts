import { createRequire } from "node:module";
import type { KernelClient } from "../src/core/kernel";
import { TranslatorService } from "../src/services/translator";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import type { TranslationState } from "../src/types/status";
import { paper } from "./fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("counts preparation as running and rejects duplicate jobs before the child starts", async () => {
  const pending = deferred<ReturnType<typeof paper>>();
  const state = vi.fn();
  const translator = new TranslatorService({} as KernelClient, {
    requireFn: createRequire(import.meta.url), readPaper: () => pending.promise, persist: vi.fn(), onState: state,
  });
  const first = translator.translate("doc", DEFAULT_SETTINGS);
  expect(translator.isRunning()).toBe(true);
  await expect(translator.translate("doc", DEFAULT_SETTINGS)).rejects.toThrow(/已在翻译队列/);
  pending.resolve(paper());
  await expect(first).rejects.toThrow(/没有可翻译/);
  expect(translator.isRunning()).toBe(false);
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
});

it("cancels both preparation and waiting jobs without starting a process", async () => {
  const pending = deferred<ReturnType<typeof paper>>();
  const readPaper = vi.fn(() => pending.promise);
  const kernel = { getWorkspaceInfo: vi.fn() };
  const states: TranslationState[] = [];
  const translator = new TranslatorService(kernel as unknown as KernelClient, {
    requireFn: createRequire(import.meta.url), readPaper, persist: vi.fn(), onState: (state) => states.push(state),
  });
  const first = translator.translate("one", DEFAULT_SETTINGS);
  const second = translator.translate("two", DEFAULT_SETTINGS);
  const outcomes = Promise.allSettled([first, second]);
  expect(states.at(-1)).toMatchObject({ state: "running", queued: 1 });
  translator.cancel();
  pending.resolve(paper());
  for (const outcome of await outcomes) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/取消/);
  }
  expect(readPaper).toHaveBeenCalledTimes(1);
  expect(kernel.getWorkspaceInfo).not.toHaveBeenCalled();
  expect(translator.isRunning()).toBe(false);
});

it("bounds parallel preparation, fills a freed slot after failure, and cancels every remaining job", async () => {
  const pending = new Map(["one", "two", "three", "four"].map((id) => [id, deferred<ReturnType<typeof paper>>() ]));
  const readPaper = vi.fn((id: string) => pending.get(id)!.promise);
  const states: TranslationState[] = [];
  const translator = new TranslatorService({} as KernelClient, {
    requireFn: createRequire(import.meta.url), readPaper, persist: vi.fn(), onState: (state) => states.push(state),
  });
  const jobs = [...pending.keys()].map((id) => translator.translate(id, { ...DEFAULT_SETTINGS, translationConcurrency: 2 }));
  const outcomes = Promise.allSettled(jobs);
  expect(readPaper.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
  expect(states.at(-1)).toMatchObject({ state: "running", active: 2, queued: 2 });
  await expect(translator.translate("two", DEFAULT_SETTINGS)).rejects.toThrow(/已在翻译队列/);
  pending.get("one")!.resolve(paper());
  await expect(jobs[0]).rejects.toThrow(/没有可翻译/);
  expect(readPaper.mock.calls.map(([id]) => id)).toEqual(["one", "two", "three"]);
  expect(states.at(-1)).toMatchObject({ state: "running", active: 2, queued: 1 });
  translator.cancel();
  pending.get("two")!.resolve(paper());
  pending.get("three")!.resolve(paper());
  const results = await outcomes;
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(readPaper).toHaveBeenCalledTimes(3);
  expect(translator.isRunning()).toBe(false);
});

it("kills every concurrent child process and never starts a queued process after cancellation", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "paper-parallel-"));
  mkdirSync(join(root, "data", "assets"), { recursive: true });
  writeFileSync(join(root, "data", "assets", "input.pdf"), "%PDF-1.4\n");
  const fixture = fileURLToPath(new URL("./fixtures/fake-pdf2zh.mjs", import.meta.url));
  const ready = deferred<void>();
  const children: import("node:child_process").ChildProcess[] = [];
  let readyCount = 0;
  const persist = vi.fn();
  const translator = new TranslatorService({ getWorkspaceInfo: async () => ({ workspaceDir: root }) } as KernelClient, {
    requireFn: createRequire(import.meta.url), persist,
    readPaper: async () => paper({ attachments: [{ title: "input", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "test" }] }),
    spawnProcess: (command, args, options) => {
      const child = spawn(command, [fixture, ...args], options);
      children.push(child);
      child.stdout!.once("data", () => { if (++readyCount === 2) ready.resolve(); });
      return child;
    },
  });
  try {
    const settings = { ...DEFAULT_SETTINGS, pdf2zhPath: process.execPath, pdf2zhArgs: ["--fixture-wait"], translationConcurrency: 2 };
    const outcomes = Promise.allSettled(["one", "two", "three"].map((id) => translator.translate(id, settings)));
    await ready.promise;
    expect(children).toHaveLength(2);
    translator.cancel();
    expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(children).toHaveLength(2);
    expect(persist).not.toHaveBeenCalled();
    expect(translator.isRunning()).toBe(false);
  } finally {
    translator.cancel();
    rmSync(root, { recursive: true, force: true });
  }
});
