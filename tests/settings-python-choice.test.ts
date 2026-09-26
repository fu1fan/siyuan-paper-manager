import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { SettingsPanel } from "../src/ui/settings";
import * as deployment from "../src/services/pdf2zh-deployment";

vi.mock("../src/services/pdf2zh-deployment", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/pdf2zh-deployment")>(),
  scanPython: vi.fn(),
  findUv: vi.fn(),
  installPdf2zh: vi.fn(),
  resolvePdf2zh: vi.fn(),
  inspectPdf2zh: vi.fn(),
  detectPdf2zh: vi.fn(),
}));

type TestPanel = {
  draft: typeof DEFAULT_SETTINGS;
  scanPython(root: HTMLElement): Promise<void>;
  scanPdf2zh(root: HTMLElement): Promise<void>;
  updatePythonChoice(root: HTMLElement, python: string): void;
  installPdf2zh(root: HTMLElement, upgrade?: boolean): Promise<void>;
};

function panel(): TestPanel {
  return new SettingsPanel("test", () => ({ ...DEFAULT_SETTINGS }),
    {} as never, {} as never, async () => {}) as unknown as TestPanel;
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
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("C:/Custom/python.exe", expect.anything(), undefined, expect.any(Function));
});

it("uses the latest dropdown choice for upgrade and updates the manual field", async () => {
  const settings = panel();
  const { root, select, manual } = fixture();
  await settings.scanPython(root);
  settings.updatePythonChoice(root, "C:/Custom/python.exe");
  settings.updatePythonChoice(root, "C:/Python312/python.exe");
  expect(select.value).toBe("C:/Python312/python.exe");
  expect(manual.value).toBe("C:/Python312/python.exe");
  await settings.installPdf2zh(root, true);
  expect(deployment.installPdf2zh).toHaveBeenCalledWith("C:/Python312/python.exe", expect.anything(), undefined, expect.any(Function));
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
