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
