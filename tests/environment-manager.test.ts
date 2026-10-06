// @vitest-environment happy-dom
import { vi } from "vitest";
import { createRequire } from "node:module";
import { EnvironmentManager } from "../src/ui/environment-manager";
import { probePdf2zh } from "../src/services/environment-check";
import { resolveExecutable } from "../src/services/translator";
import { pdf2zhActivity } from "../src/services/environment-activity";
import { SettingsPanel } from "../src/ui/settings";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import * as deployment from "../src/services/pdf2zh-deployment";

vi.mock("siyuan", async importOriginal => ({
  ...await importOriginal<typeof import("siyuan")>(),
  Dialog: class {
    element = document.createElement("div");
    constructor(private options: { content: string; destroyCallback?: () => void }) {
      this.element.innerHTML = `<div class="b3-dialog__container">${options.content}</div>`;
      document.body.append(this.element);
    }
    destroy() { this.element.remove(); this.options.destroyCallback?.(); }
  },
}));
vi.mock("../src/services/environment-check", () => ({ probePdf2zh: vi.fn(async () => ({ ok: true, detail: "OK" })) }));
vi.mock("../src/services/translator", () => ({ resolveExecutable: vi.fn(async (value: string) => value) }));
vi.mock("../src/services/pdf2zh-deployment", async importOriginal => ({
  ...await importOriginal<typeof import("../src/services/pdf2zh-deployment")>(),
  manageUvToolPdf2zh: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  inspectUvToolPdf2zh: vi.fn(async () => null),
  inspectPdf2zh: vi.fn(async () => null), detectPdf2zh: vi.fn(async () => null),
  findUv: vi.fn(async () => ({ file: "uv", argsPrefix: [], display: "uv" })),
  resolvePdf2zh: vi.fn(async () => "/managed/pdf2zh"), installPdf2zh: vi.fn(),
}));

let manager: EnvironmentManager;
let current = structuredClone(DEFAULT_SETTINGS);
const save = vi.fn(async (settings: typeof DEFAULT_SETTINGS) => { current = settings; });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue(null);
  vi.mocked(deployment.detectPdf2zh).mockResolvedValue(null);
  vi.mocked(deployment.inspectUvToolPdf2zh).mockResolvedValue(null);
  vi.mocked(probePdf2zh).mockResolvedValue({ok:true, detail:"OK"});
  vi.mocked(resolveExecutable).mockImplementation(async value => value);
  window.require = createRequire(import.meta.url);
  current = structuredClone(DEFAULT_SETTINGS);
  manager = new EnvironmentManager(() => current, save);
  manager.mountStatusBar({ addStatusBar: ({ element }: { element: HTMLElement }) => document.body.append(element) } as never);
});
afterEach(() => { manager.destroy(); document.body.innerHTML = ""; });
function button(selector: string): HTMLButtonElement { return document.querySelector<HTMLButtonElement>(selector)!; }
async function ready() {
  manager.open();
  await vi.waitFor(() => expect(button("[data-install-pdf2zh]").disabled).toBe(false));
}
function deferInstall() {
  let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
  vi.mocked(deployment.installPdf2zh).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  return () => finish({ code: 0, stdout: "", stderr: "" });
}

it("keeps a single running job and the same view/log when closed and restored from status bar", async () => {
  const finish = deferInstall();
  await ready();
  const root = document.querySelector(".paper-manager-environment");
  button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(deployment.installPdf2zh).mock.calls[0]![4]!.signal!;
  button("[data-env-close]").click();
  const status = button(".paper-manager-environment-status");
  await vi.waitFor(() => expect(status.hidden).toBe(false));
  expect(signal.aborted).toBe(false);
  expect(status.textContent).toContain("安装 pdf2zh");
  status.click();
  expect(document.querySelector(".paper-manager-environment")).toBe(root);
  expect(button("[data-install-pdf2zh]").disabled).toBe(true);
  expect(document.querySelector("[data-term-log]")!.textContent).toContain("tool install");
  manager.open();
  expect(document.querySelectorAll(".paper-manager-environment")).toHaveLength(1);
  finish();
  await vi.waitFor(() => expect(current.pdf2zhPath).toBe("/managed/pdf2zh"));
  await vi.waitFor(() => expect(button("[data-install-pdf2zh]").disabled).toBe(false));
  expect(deployment.installPdf2zh).toHaveBeenCalledTimes(1);
});

it("retains a background failure until its result is opened and allows retry", async () => {
  let fail!: () => void;
  vi.mocked(deployment.installPdf2zh).mockImplementation(() => new Promise(resolve => {
    fail = () => resolve({ code: 1, stdout: "", stderr: "network offline" });
  }));
  await ready();
  button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledOnce());
  button("[data-env-close]").click(); fail();
  const status = button(".paper-manager-environment-status");
  await vi.waitFor(() => expect(status.dataset.state).toBe("finished"));
  expect(status.hidden).toBe(false);
  status.click();
  expect(document.querySelector("[data-deploy-status]")!.textContent).toContain("network offline");
  await vi.waitFor(() => expect(button("[data-install-pdf2zh]").disabled).toBe(false));
  expect(current.pdf2zhPath).toBe("pdf2zh");
});

it("cancels on plugin unload and does not save a late installation result", async () => {
  const finish = deferInstall(); await ready();
  button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledOnce());
  const signal = vi.mocked(deployment.installPdf2zh).mock.calls[0]![4]!.signal!;
  const writes = save.mock.calls.length;
  manager.destroy(); finish();
  expect(signal.aborted).toBe(true);
  await vi.waitFor(() => expect((manager as unknown as { deployBusy: boolean }).deployBusy).toBe(false));
  expect(save).toHaveBeenCalledTimes(writes);
  expect(document.querySelector(".paper-manager-environment-status")).toBeNull();
});

it("preserves newer environment values when a previously opened settings draft is saved", async () => {
  const panel = new SettingsPanel("test", () => current, {} as never, {} as never, save);
  current = { ...current, pdf2zhPath: "/new/pdf2zh", pdf2zhIndexUrl: "https://mirror.test/simple" };
  await (panel as unknown as { save(): Promise<void> }).save();
  expect(current.pdf2zhPath).toBe("/new/pdf2zh");
  expect(current.pdf2zhIndexUrl).toBe("https://mirror.test/simple");
  panel.environment.destroy();
});

it("saves a successful background install without overwriting unrelated edits made while it ran", async () => {
  const finish = deferInstall(); await ready();
  button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledOnce());
  button("[data-env-close]").click();
  current = { ...current, translateTo: "ja", translationThreads: 12 };
  finish();
  const status = button(".paper-manager-environment-status");
  await vi.waitFor(() => expect(status.dataset.state).toBe("finished"));
  expect(current.pdf2zhPath).toBe("/managed/pdf2zh");
  expect(current.translateTo).toBe("ja");
  expect(current.translationThreads).toBe(12);
  expect(status.hidden).toBe(false);
  status.click();
  expect(document.querySelector("[data-deploy-status]")!.textContent).toContain("安装完成");
});

it("restores a working cancel button and leaves the configured executable unchanged on cancellation", async () => {
  vi.mocked(deployment.installPdf2zh).mockImplementation((_python, _uv, _require, _line, options) => new Promise(resolve => {
    options!.signal!.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "cancelled" }));
  }));
  await ready(); button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledOnce());
  button("[data-env-close]").click();
  button(".paper-manager-environment-status").click();
  button("[data-cancel-install]").click();
  await vi.waitFor(() => expect(button("[data-install-pdf2zh]").disabled).toBe(false));
  expect(document.querySelector("[data-deploy-status]")!.textContent).toContain("安装已取消");
  expect(current.pdf2zhPath).toBe("pdf2zh");
});

it("offers all three management actions for a registered uv installation created outside the plugin", async () => {
  const target = { executable: "/user/bin/pdf2zh", version: "1.9.11", toolDir: "/user/tools", binDir: "/user/bin", uv: { file: "uv", argsPrefix: [], display: "uv" } };
  vi.mocked(deployment.detectPdf2zh).mockResolvedValue(target.executable);
  vi.mocked(deployment.inspectUvToolPdf2zh).mockResolvedValue(target);
  await ready();
  for (const selector of ["[data-upgrade-pdf2zh]", "[data-repair-pdf2zh]", "[data-uninstall-pdf2zh]"]) {
    expect(button(selector).hidden).toBe(false); expect(button(selector).disabled).toBe(false);
  }
  expect(button("[data-install-pdf2zh]").hidden).toBe(true);
  button("[data-repair-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.manageUvToolPdf2zh).toHaveBeenCalledWith(target.executable, "repair", expect.anything(), undefined, expect.any(Function)));
  await vi.waitFor(() => expect(button("[data-repair-pdf2zh]").disabled).toBe(false));
});

const target = { executable: "/managed/bin/pdf2zh", version: "1.9.11", toolDir: "/managed/tools", binDir: "/managed/bin", uv: { file: "uv", argsPrefix: [], display: "uv" } };
function selectTarget() {
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue(target);
  vi.mocked(deployment.inspectUvToolPdf2zh).mockImplementation(async exe => exe === target.executable ? target : null);
}
it.each(["repair", "uninstall"])("%s binds to the detected broken tool even when configured pdf2zh resolves elsewhere", async action => {
  selectTarget();
  vi.mocked(probePdf2zh).mockResolvedValue({ok:false, detail:"broken dependency"});
  vi.mocked(resolveExecutable).mockImplementation(async exe => exe === "pdf2zh" ? "/other/bin/pdf2zh" : exe);
  await ready();
  button(action === "repair" ? "[data-repair-pdf2zh]" : "[data-uninstall-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.manageUvToolPdf2zh).toHaveBeenCalled());
  expect(vi.mocked(deployment.manageUvToolPdf2zh).mock.calls[0]![0]).toBe(target.executable);
  await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
  expect(current.pdf2zhPath).toBe("pdf2zh");
});
it("explicitly activates a detected candidate, while detection alone leaves settings unchanged", async () => {
  selectTarget(); await ready();
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector("[data-pdf2zh-status]")!.textContent).toContain("尚未启用");
  expect(button("[data-env-activate]").hidden).toBe(false);
  button("[data-env-activate]").click();
  await vi.waitFor(() => expect(current.pdf2zhPath).toBe(target.executable));
  await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
  expect(button("[data-env-activate]").hidden).toBe(true);
});
it("invalidates stale success on path edits and refuses to activate an invalid path", async () => {
  current.pdf2zhPath = target.executable; selectTarget(); await ready();
  const input = document.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]")!;
  input.value = "/missing/pdf2zh"; input.dispatchEvent(new Event("input", {bubbles:true}));
  expect(document.querySelector("[data-pdf2zh-status]")!.textContent).not.toContain("启动检查通过");
  vi.mocked(resolveExecutable).mockRejectedValue(new Error("not found"));
  button("[data-env-activate]").click();
  await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
  expect(current.pdf2zhPath).toBe(target.executable);
  expect(save).not.toHaveBeenCalled();
  button("[data-env-save]").click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(current.pdf2zhPath).toBe(target.executable);
});
it("initializes a saved custom Python and can select automatic before scanning", async () => {
  current.pythonPath = "/custom/python3.11"; await ready();
  const select = document.querySelector<HTMLSelectElement>("[data-python-select]")!;
  expect(select.value).toBe("__custom__");
  expect(select.selectedOptions[0]!.textContent).toContain(current.pythonPath);
  select.value = ""; select.dispatchEvent(new Event("change", {bubbles:true}));
  expect(document.querySelector<HTMLInputElement>("[data-python-manual]")!.value).toBe("");
  button("[data-env-save]").click();
  await vi.waitFor(() => expect(current.pythonPath).toBe(""));
});
it("never requests automatic dependency mutation when opening or rechecking", async () => {
  current.pdf2zhPath = target.executable; await ready();
  button("[data-scan-pdf2zh]").click();
  await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
  for (const call of vi.mocked(probePdf2zh).mock.calls) expect(call[3]?.autoRepair).toBe(false);
});
it("refreshes saved settings and checks again when reopening an idle view", async () => {
  current.pdf2zhPath = target.executable; await ready();
  const calls = vi.mocked(probePdf2zh).mock.calls.length;
  button("[data-env-close]").click();
  current = {...current, pdf2zhPath:"/new/bin/pdf2zh"};
  manager.open();
  await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
  expect(document.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]")!.value).toBe(current.pdf2zhPath);
  expect(probePdf2zh).toHaveBeenCalledTimes(calls + 1);
});
it("holds the shared mutation lock while an install runs in the background", async () => {
  const finish = deferInstall(); await ready(); button("[data-install-pdf2zh]").click();
  await vi.waitFor(() => expect(deployment.installPdf2zh).toHaveBeenCalledOnce());
  button("[data-env-close]").click();
  expect(() => pdf2zhActivity.acquireTranslation()).toThrow("翻译环境正在");
  finish();
  await vi.waitFor(() => expect(button(".paper-manager-environment-status").dataset.state).toBe("finished"));
  const release = pdf2zhActivity.acquireTranslation(); release();
});
it("rejects installation while any translation lease is queued", async () => {
  await ready(); const release = pdf2zhActivity.acquireTranslation();
  try {
    button("[data-install-pdf2zh]").click();
    await vi.waitFor(() => expect(button("[data-env-save]").disabled).toBe(false));
    expect(deployment.installPdf2zh).not.toHaveBeenCalled();
    expect(document.querySelector("[data-deploy-status]")!.textContent).toContain("排队");
  } finally { release(); }
});
