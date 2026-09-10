import { EventEmitter } from "node:events";
import { DesktopCnkiTransport, type CnkiElectron } from "../src/services/cnki-desktop";
const ui = vi.hoisted(() => ({ elements: new Map<string, { disabled: boolean; textContent: string; onclick?: () => void }>() }));
vi.mock("siyuan", () => ({
  getFrontend: () => "desktop",
  Dialog: class {
    element = { querySelector: (key: string) => {
      if (!ui.elements.has(key)) ui.elements.set(key, { disabled: true, textContent: "" });
      return ui.elements.get(key);
    } };
    destroy() {}
  },
}));
function setup() {
  ui.elements.clear();
  const win = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), getURL: vi.fn(() => "https://kns.cnki.net/verify/home"), getTitle: vi.fn(() => "安全验证") }),
    loadURL: vi.fn<() => Promise<void>>(), close: vi.fn(), isDestroyed: () => false, focus: vi.fn(),
  });
  const runtime = {
    session: { fromPartition: () => ({ setPermissionRequestHandler() {} }) },
    BrowserWindow: function () { return win; },
  } as unknown as CnkiElectron;
  return { win, transport: new DesktopCnkiTransport(runtime) };
}
afterEach(() => vi.useRealTimers());
it("retries transient TLS failure in the same window and enables continue only after load", async () => {
  vi.useFakeTimers();
  const { win, transport } = setup();
  win.loadURL.mockRejectedValueOnce(new Error("ERR_SSL_BAD_RECORD_MAC_ALERT (-126)")).mockResolvedValueOnce();
  const result = transport.verify("https://kns.cnki.net/kns8s/defaultresult/index");
  await vi.advanceTimersByTimeAsync(1000);
  expect(win.loadURL).toHaveBeenCalledTimes(2);
  expect(win.close).not.toHaveBeenCalled();
  expect(ui.elements.get("[data-cnki-continue]")!.disabled).toBe(false);
  ui.elements.get("[data-cnki-continue]")!.onclick!();
  await result;
});
it("keeps failed windows open after bounded retries and supports manual reload", async () => {
  vi.useFakeTimers();
  const { win, transport } = setup();
  win.loadURL.mockRejectedValue(new Error("ERR_SSL_BAD_RECORD_MAC_ALERT"));
  const result = transport.verify("https://kns.cnki.net/");
  await vi.advanceTimersByTimeAsync(4000);
  expect(win.loadURL).toHaveBeenCalledTimes(3);
  expect(win.close).not.toHaveBeenCalled();
  expect(ui.elements.get("[data-cnki-status]")!.textContent).toContain("窗口已保留");
  expect(ui.elements.get("[data-cnki-continue]")!.disabled).toBe(true);
  win.loadURL.mockResolvedValueOnce();
  ui.elements.get("[data-cnki-retry]")!.onclick!();
  await Promise.resolve();
  ui.elements.get("[data-cnki-continue]")!.onclick!();
  await result;
});
it("cancels pending retries when the import closes", async () => {
  vi.useFakeTimers();
  const { win, transport } = setup();
  win.loadURL.mockRejectedValue(new Error("ERR_SSL_BAD_RECORD_MAC_ALERT"));
  const controller = new AbortController();
  const result = transport.verify("https://kns.cnki.net/", controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(4000);
  expect(win.loadURL).toHaveBeenCalledTimes(1);
});

it("automatically continues after captcha redirects to a loaded CNKI home page", async () => {
  const { win, transport } = setup();
  win.loadURL.mockResolvedValue();
  const result = transport.verify("https://kns.cnki.net/verify/home");
  win.webContents.emit("did-finish-load");
  expect(win.close).not.toHaveBeenCalled();
  win.webContents.getURL.mockReturnValue("https://www.cnki.net/");
  win.webContents.getTitle.mockReturnValue("中国知网");
  win.webContents.emit("did-finish-load");
  await result;
  expect(win.close).toHaveBeenCalledTimes(1);
});
