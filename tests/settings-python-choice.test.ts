import { vi } from "vitest";
import { createRequire } from "node:module";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { SettingsPanel } from "../src/ui/settings";
import * as deployment from "../src/services/pdf2zh-deployment";
import { resolveExecutable } from "../src/services/translator";
import { probePdf2zh } from "../src/services/environment-check";

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

vi.mock("../src/services/translator", () => ({ resolveExecutable: vi.fn() }));
vi.mock("../src/services/environment-check", () => ({ probePdf2zh: vi.fn() }));

vi.mock("../src/services/pdf2zh-deployment", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/pdf2zh-deployment")>(),
  scanPython: vi.fn(),
  findUv: vi.fn(),
  installPdf2zh: vi.fn(),
  resolvePdf2zh: vi.fn(),
  inspectPdf2zh: vi.fn(),
  detectPdf2zh: vi.fn(),
  validateDeploymentPython: vi.fn(),
  sameExecutable: vi.fn((a, b) => a === b),
  uninstallPdf2zh: vi.fn(),
}));

type TestPanel = {
  draft: typeof DEFAULT_SETTINGS;
  scanPython(root: HTMLElement): Promise<void>;
  scanPdf2zh(root: HTMLElement): Promise<void>;
  updatePythonChoice(root: HTMLElement, python: string): void;
  installPdf2zh(root: HTMLElement, upgrade?: boolean, repair?: boolean): Promise<void>;
  uninstallPdf2zh(root: HTMLElement): Promise<void>;
  loadConfig(root: HTMLElement): Promise<void>;
};

function panel(): TestPanel {
  const result = new SettingsPanel("test", () => ({ ...DEFAULT_SETTINGS }),
    {} as never, {} as never, async () => {}) as unknown as TestPanel;
  result.loadConfig = async () => {};
  return result;
}

function fixture() {
  const status = { hidden: true, textContent: "" };
  const pdfStatus = { textContent: "" };
  const manual = { value: "" };
  const select = {
    value: "",
    options: [{ value: "", disabled: false }],
    onchange: null as (() => void) | null,
    set innerHTML(html: string) {
      this.options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map((match) => ({
        value: match[1] ?? "", disabled: (match[2] ?? "").includes("disabled"),
      }));
      // Native selects choose the first option when no explicit selection exists.
      this.value = this.options[0]?.value ?? "";
    },
  };
  const details = { hidden: true, open: false };
  const log = { textContent: "", scrollTop: 0, scrollHeight: 0 };
  const existing = { hidden: true };
  const deploy = { hidden: false };
  const detail = { textContent: "" };
  const nodes: Record<string, unknown> = {
    "[data-deploy-status]": status,
    "[data-pdf2zh-status]": pdfStatus,
    "[data-python-manual]": manual,
    "[data-python-select]": select,
    "[data-term]": details,
    "[data-term-log]": log,
    "[data-pdf2zh-existing]": existing,
    "[data-pdf2zh-deploy]": deploy,
    "[data-pdf2zh-detail]": detail,
  };
  const root = {
    querySelector: (selector: string) => nodes[selector] ?? null,
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  return { root, status, select, manual, pdfStatus };
}

beforeEach(() => {
  globalThis.window = { require: createRequire(import.meta.url) } as unknown as Window & typeof globalThis;
  vi.resetAllMocks();
  vi.mocked(deployment.scanPython).mockResolvedValue([
    { path: "C:/Python311/python.exe", aliases: [], version: "3.11.9", major: 3, minor: 11, arch: "AMD64", source: "PATH", support: "supported", global: false },
    { path: "C:/Python312/python.exe", aliases: [], version: "3.12.8", major: 3, minor: 12, arch: "AMD64", source: "PATH", support: "supported", global: false },
  ]);
  vi.mocked(deployment.findUv).mockResolvedValue({ file: "uv", argsPrefix: [], display: "uv" });
  vi.mocked(deployment.installPdf2zh).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  vi.mocked(deployment.resolvePdf2zh).mockResolvedValue("C:/uv/pdf2zh.exe");
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue(null);
  vi.mocked(deployment.detectPdf2zh).mockResolvedValue(null);
  vi.mocked(deployment.validateDeploymentPython).mockResolvedValue();
  vi.mocked(deployment.sameExecutable).mockImplementation((a, b) => a === b);
  vi.mocked(resolveExecutable).mockImplementation(async value => value === "pdf2zh" ? "C:/uv/pdf2zh.exe" : value);
  vi.mocked(probePdf2zh).mockResolvedValue({ ok: true, detail: "startup OK" });
});

it("keeps a manually entered path after scanning and deploys with it", async () => {
  const settings = panel();
  const { root, select, manual } = fixture();
  settings.updatePythonChoice(root, " C:/Custom/python.exe ");
  await settings.scanPython(root);
  expect(select.value).toBe("");
  expect(manual.value).toBe("C:/Custom/python.exe");
  await settings.installPdf2zh(root);
  expect(deployment.findUv).toHaveBeenCalledWith(undefined, "C:/Custom/python.exe");
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("C:/Custom/python.exe", expect.anything(), undefined, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("uses the latest dropdown choice for upgrade and updates the manual field", async () => {
  const settings = panel();
  const { root, select, manual } = fixture();
  await settings.scanPython(root);
  settings.updatePythonChoice(root, "C:/Custom/python.exe");
  settings.updatePythonChoice(root, "C:/Python312/python.exe");
  expect(select.value).toBe("C:/Python312/python.exe");
  expect(manual.value).toBe("C:/Python312/python.exe");
  settings.draft.pdf2zhPath = "C:/uv/pdf2zh.exe";
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue({ executable: "C:/uv/pdf2zh.exe" });
  await settings.installPdf2zh(root, true);
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("C:/Python312/python.exe", expect.anything(), undefined, expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("does not let a late automatic detection replace the user's path", async () => {
  const settings = panel();
  const { root, manual } = fixture();
  let finish!: (value: { executable: string; pythonPath: string }) => void;
  vi.mocked(deployment.inspectPdf2zh).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const scan = settings.scanPdf2zh(root);
  settings.updatePythonChoice(root, "C:/Custom/python.exe");
  finish({ executable: "C:/uv/pdf2zh.exe", pythonPath: "C:/Python311/python.exe" });
  await scan;
  expect(settings.draft.pythonPath).toBe("C:/Custom/python.exe");
  expect(manual.value).toBe("C:/Custom/python.exe");
});

it("preserves a configured executable when another installation is discovered", async () => {
  const settings = panel();
  settings.draft.pdf2zhPath = "C:/Custom/pdf2zh.exe";
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue({ executable: "C:/uv/pdf2zh.exe" });
  await settings.scanPdf2zh(fixture().root);
  expect(settings.draft.pdf2zhPath).toBe("C:/Custom/pdf2zh.exe");
  expect(resolveExecutable).toHaveBeenCalledWith("C:/Custom/pdf2zh.exe", expect.any(Function));
  expect(probePdf2zh).toHaveBeenCalledWith("C:/Custom/pdf2zh.exe", expect.anything(), 15_000, expect.objectContaining({ autoRepair: true }));
});

it("does not upgrade or uninstall an external installation", async () => {
  const settings = panel();
  settings.draft.pdf2zhPath = "C:/Custom/pdf2zh.exe";
  settings.draft.pythonPath = "C:/Python312/python.exe";
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue({ executable: "C:/uv/pdf2zh.exe" });
  const { root } = fixture();
  await settings.installPdf2zh(root, true);
  await settings.uninstallPdf2zh(root);
  expect(deployment.installPdf2zh).not.toHaveBeenCalled();
  expect(deployment.uninstallPdf2zh).not.toHaveBeenCalled();
});

it("does not adopt a detected executable that cannot start", async () => {
  const settings = panel();
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue({ executable: "C:/broken/pdf2zh.exe" });
  vi.mocked(probePdf2zh).mockResolvedValue({ ok: false, detail: "interpreter missing" });
  const { root, pdfStatus } = fixture();
  await settings.scanPdf2zh(root);
  expect(settings.draft.pdf2zhPath).toBe("pdf2zh");
  expect(pdfStatus.textContent).toContain("interpreter missing");
});

it("blocks environment mutation while translation tasks are active", async () => {
  const settings = new SettingsPanel("test", () => ({ ...DEFAULT_SETTINGS, pythonPath: "C:/Python312/python.exe" }),
    {} as never, {} as never, async () => {}, undefined, () => true) as unknown as TestPanel;
  const { root } = fixture();
  await settings.installPdf2zh(root);
  await settings.uninstallPdf2zh(root);
  expect(deployment.installPdf2zh).not.toHaveBeenCalled();
  expect(deployment.uninstallPdf2zh).not.toHaveBeenCalled();
});

it("installs automatically without a selected Python and forwards unsaved download sources", async () => {
  const settings = panel();
  settings.draft.pdf2zhIndexUrl = "https://packages.test/simple";
  const { root, status } = fixture();
  await settings.installPdf2zh(root);
  expect(deployment.validateDeploymentPython).not.toHaveBeenCalled();
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("", expect.anything(), undefined, expect.any(Function), expect.objectContaining({ pdf2zhIndexUrl: "https://packages.test/simple" }));
  expect(status.textContent).toContain("安装完成");
  expect(settings.draft.pythonPath).toBe("");
});

it("allows explicit repair for a managed installation that fails startup", async () => {
  const settings = panel();
  const { root } = fixture();
  settings.draft.pdf2zhPath = "C:/uv/pdf2zh.exe";
  vi.mocked(deployment.inspectPdf2zh).mockResolvedValue({ executable: "C:/uv/pdf2zh.exe" });
  vi.mocked(probePdf2zh).mockResolvedValue({ ok: false, detail: "broken dependency" });
  await settings.scanPdf2zh(root);
  expect((settings as unknown as { managedSelection: boolean }).managedSelection).toBe(true);
  await settings.installPdf2zh(root, false, true);
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("", expect.anything(), undefined, expect.any(Function), expect.objectContaining({ repair: true, upgrade: false }));
});
