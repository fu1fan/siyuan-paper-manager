import { getFrontend } from "siyuan";
import { canUseNode } from "../src/core/env";
import { buildEnvironmentReport } from "../src/services/environment-check";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { StatusStore } from "../src/core/status";

vi.mock("siyuan", () => ({ getFrontend: vi.fn(() => "mobile") }));
afterEach(() => vi.unstubAllGlobals());

it.each(["mobile", "browser-mobile", "browser-desktop"])("never uses a require shim on %s", async (frontend) => {
  vi.mocked(getFrontend).mockReturnValue(frontend as ReturnType<typeof getFrontend>);
  const require = vi.fn();
  vi.stubGlobal("window", { require });
  expect(canUseNode()).toBe(false);
  const report = await buildEnvironmentReport(DEFAULT_SETTINGS, new StatusStore().get());
  expect(report.connector.skipped).toBe(true);
  expect(report.pdf2zh.skipped).toBe(true);
  expect(require).not.toHaveBeenCalled();
});

it.each(["desktop", "desktop-window"])("retains Node support on %s", (frontend) => {
  vi.mocked(getFrontend).mockReturnValue(frontend as ReturnType<typeof getFrontend>);
  vi.stubGlobal("window", { require: vi.fn() });
  expect(canUseNode()).toBe(true);
});
