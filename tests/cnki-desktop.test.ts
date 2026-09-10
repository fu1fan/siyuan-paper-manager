import { EventEmitter } from "node:events";
import { DesktopCnkiTransport, type CnkiElectron } from "../src/services/cnki-desktop";
function adapter() {
  const session = { setPermissionRequestHandler: vi.fn() };
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), abort: vi.fn(), followRedirect: vi.fn() });
  const electron = { session: { fromPartition: vi.fn(() => session) }, net: { request: vi.fn(() => request) } } as unknown as CnkiElectron;
  return { transport: new DesktopCnkiTransport(electron), session, request, response, electron };
}
it("sends requests through the verification session and preserves Chinese response bytes", async () => {
  const { transport, session, request, response, electron } = adapter();
  const result = transport.request({ url: "https://kns.cnki.net/kns8s/brief/grid", method: "POST", body: "query=1", headers: { Referer: "https://kns.cnki.net/" } });
  expect(electron.net.request).toHaveBeenCalledWith(expect.objectContaining({ session, useSessionCookies: true, method: "POST" }));
  request.emit("response", response);
  const bytes = new TextEncoder().encode("中文结果");
  response.emit("data", bytes.slice(0, 2)); response.emit("data", bytes.slice(2)); response.emit("end");
  expect((await result).text).toBe("中文结果");
  transport.dispose();
  expect(request.abort).not.toHaveBeenCalled();
});
it("aborts pending requests when the import is cancelled or the plugin unloads", async () => {
  for (const mode of ["signal", "dispose"]) {
    const { transport, request } = adapter();
    const controller = new AbortController();
    const result = transport.request({ url: "https://kns.cnki.net/", method: "GET", headers: {} }, controller.signal);
    if (mode === "signal") controller.abort(); else transport.dispose();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(request.abort).toHaveBeenCalledTimes(1);
  }
});
it("retains the final verification URL for HTTP 200 challenge detection", async () => {
  const { transport, request, response } = adapter();
  const result = transport.request({ url: "https://kns.cnki.net/", method: "GET", headers: {} });
  request.emit("redirect", 302, "GET", "https://kns.cnki.net/verify/home");
  request.emit("response", response); response.emit("end");
  expect((await result).url).toBe("https://kns.cnki.net/verify/home");
  expect(request.followRedirect).not.toHaveBeenCalled();
});

it("does not open new requests after plugin unload", async () => {
  const { transport, electron } = adapter();
  transport.dispose();
  await expect(transport.request({ url: "https://kns.cnki.net/", method: "GET", headers: {} })).rejects.toThrow("会话已关闭");
  expect(electron.net.request).not.toHaveBeenCalled();
});
it("returns search timeout without retrying", async () => {
  vi.useFakeTimers();
  try {
    const { transport, electron } = adapter();
    const result = transport.request({ url: "https://kns.cnki.net/kns8s/brief/grid", method: "POST", headers: {} });
    const rejected = expect(result).rejects.toThrow("10秒");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(electron.net.request).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it("caps optional export timeout at ten seconds without retrying", async () => {
  vi.useFakeTimers();
  try {
    const { transport, electron } = adapter();
    const result = transport.request({ url: "https://kns.cnki.net/dm8/API/GetExport", method: "POST", headers: {} });
    const rejected = expect(result).rejects.toThrow("10秒");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(electron.net.request).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("reports response status and received bytes when export stalls", async () => {
  vi.useFakeTimers();
  try {
    const { transport, request, response } = adapter();
    const result = transport.request({ url: "https://kns.cnki.net/dm8/API/GetExport", method: "POST", headers: {} });
    request.emit("response", response);
    response.emit("data", new TextEncoder().encode("abc"));
    const rejected = expect(result).rejects.toThrow("HTTP 200，等待响应结束，已接收 3 字节");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  } finally { vi.useRealTimers(); }
});
it("reports an interrupted response immediately", async () => {
  const { transport, request, response } = adapter();
  const result = transport.request({ url: "https://kns.cnki.net/dm8/API/GetExport", method: "POST", headers: {} });
  request.emit("response", response);
  response.emit("aborted");
  await expect(result).rejects.toThrow("响应传输中断");
  expect(request.abort).toHaveBeenCalledTimes(1);
});
it("uses the configured timeout for the timer and error message", async () => {
  vi.useFakeTimers();
  try {
    const { transport, request } = adapter();
    transport.timeoutSeconds = 3;
    const result = transport.request({ url: "https://kns.cnki.net/kns8s/brief/grid", method: "POST", headers: {} });
    const rejected = expect(result).rejects.toThrow("3秒");
    await vi.advanceTimersByTimeAsync(2999);
    expect(request.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  } finally { vi.useRealTimers(); }
});
it("registers end before data starts a remote response flowing", async () => {
  const { transport, request, response } = adapter();
  const originalOn = response.on.bind(response);
  response.on = ((event: string, listener: (...args: unknown[]) => void) => {
    originalOn(event, listener);
    if (event === "data") {
      response.emit("data", new TextEncoder().encode("完整正文"));
      response.emit("end");
    }
    return response;
  }) as typeof response.on;
  const result = transport.request({ url: "https://kns.cnki.net/kns8s/brief/grid", method: "POST", headers: {} });
  request.emit("response", response);
  expect((await result).text).toBe("完整正文");
});
