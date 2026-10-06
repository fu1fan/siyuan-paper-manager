import { createRequire } from "node:module";
import { EnvironmentActivity, pdf2zhActivity } from "../src/services/environment-activity";
import { TranslatorService } from "../src/services/translator";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import type { KernelClient } from "../src/core/kernel";

it("allows parallel readers, excludes mutation, and releases leases exactly once", () => {
  const activity = new EnvironmentActivity();
  const a = activity.acquireTranslation(), b = activity.acquireTranslation();
  expect(() => activity.acquireMutation()).toThrow("排队");
  a(); a();
  expect(() => activity.acquireMutation()).toThrow("排队");
  b();
  const write = activity.acquireMutation();
  expect(() => activity.acquireTranslation()).toThrow("翻译环境正在");
  expect(() => activity.acquireMutation()).toThrow("已有");
  write(); write();
  activity.acquireTranslation()();
});
it("blocks actual translation admission during deployment before reading any paper", async () => {
  const readPaper = vi.fn();
  const service = new TranslatorService({} as KernelClient, {
    requireFn:createRequire(import.meta.url), readPaper, persist:vi.fn(),
  });
  const release = pdf2zhActivity.acquireMutation();
  try {
    await expect(service.translate("doc", DEFAULT_SETTINGS)).rejects.toThrow("翻译环境正在");
    expect(readPaper).not.toHaveBeenCalled(); expect(service.isRunning()).toBe(false);
  } finally { release(); }
});
it("retains the lock through running and queued jobs, releasing cancelled and failed jobs", async () => {
  let fail!: (reason: Error) => void;
  const service = new TranslatorService({} as KernelClient, {
    requireFn:createRequire(import.meta.url), persist:vi.fn(),
    readPaper: () => new Promise((_resolve, reject) => { fail = reject; }),
  });
  const a = service.translate("a", DEFAULT_SETTINGS).catch(error => error);
  const b = service.translate("b", DEFAULT_SETTINGS).catch(error => error);
  expect(service.taskState("b")).toBe("queued");
  expect(() => pdf2zhActivity.acquireMutation()).toThrow("排队");
  service.cancel();
  expect(() => pdf2zhActivity.acquireMutation()).toThrow("排队");
  fail(new Error("fixture failure")); await Promise.all([a,b]);
  expect(service.isRunning()).toBe(false);
  pdf2zhActivity.acquireMutation()();
});
