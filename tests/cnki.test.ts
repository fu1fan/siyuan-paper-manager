import { CnkiClient, cnkiChallenge, cnkiSearchRequest, trustedCnkiUrl, type CnkiTransport } from "../src/services/cnki-client";
import { paper } from "./fixtures";

const html = { status: 200, url: "https://kns.cnki.net/kns8s/brief/grid", text: "<table class='result-table-list'></table>" };
function setup(responses = [html]) {
  const request = vi.fn(async () => responses.shift() ?? html);
  const verify = vi.fn(async () => {});
  return { request, verify, client: new CnkiClient({ request, verify }) };
}
it("submits title and complete Chinese author to the grid endpoint for both regions", () => {
  for (const region of ["mainland", "oversea"] as const) {
    const request = cnkiSearchRequest(paper().canonical, region);
    expect(request.method).toBe("POST");
    expect(request.url).toContain(region === "mainland" ? "/brief/grid" : "/Brief/GetGridTableHtml");
    const query = JSON.parse(new URLSearchParams(request.body).get("QueryJson")!);
    expect(query.QNode.QGroup[0].Items[0].Value).toBe("TI %= '示例论文 Example Paper' AND AU='张三'");
  }
});
it("reuses the verified session and retries a 403 after manual verification", async () => {
  const { client, request, verify } = setup([{ ...html, status: 403, text: JSON.stringify({ message: "https://kns.cnki.net/verify/home?id=1" }) }, html]);
  expect(await client.search(paper().canonical)).toEqual(html);
  await client.search(paper().canonical);
  expect(verify.mock.calls).toHaveLength(2);
  expect(request.mock.calls).toHaveLength(3);
});
it("detects HTTP 200 captcha pages instead of reporting zero candidates", async () => {
  const challenge = { ...html, url: "https://kns.cnki.net/verify/home", text: "<title>验证</title>" };
  const { client, verify } = setup([challenge, challenge]);
  await expect(client.search(paper().canonical)).rejects.toThrow("验证尚未通过");
  expect(verify).toHaveBeenCalledTimes(2);
  expect(cnkiChallenge({ ...html, text: '<title>captcha</title>' })).toBe(html.url);
});
it("does not treat an ordinary 200 search result as a challenge", () => {
  expect(cnkiChallenge(html)).toBeUndefined();
});
it("rejects untrusted verification targets", () => {
  expect(() => trustedCnkiUrl("https://evil.example/verify")).toThrow();
  expect(() => trustedCnkiUrl("http://kns.cnki.net/")).toThrow();
  expect(() => cnkiChallenge({ ...html, status: 403, text: '{"message":"https://evil.example"}' })).toThrow();
});
it("does not start a queued search after cancellation", async () => {
  let finish!: () => void;
  const verify = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const transport: CnkiTransport = { verify, request: vi.fn(async () => html) };
  const client = new CnkiClient(transport);
  const first = client.search(paper().canonical);
  const controller = new AbortController();
  const second = client.search(paper().canonical, "mainland", controller.signal);
  controller.abort();
  await Promise.resolve();
  finish();
  await first;
  await expect(second).rejects.toThrow();
  expect(transport.request).toHaveBeenCalledTimes(1);
});
it("refreshes an expired session", async () => {
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(1_000_000);
  const { client, verify } = setup();
  await client.search(paper().canonical);
  clock.mockReturnValue(1_400_000);
  await client.search(paper().canonical);
  expect(verify).toHaveBeenCalledTimes(2);
  clock.mockRestore();
});

it("parses EndNote thesis metadata without discarding existing local fields", async () => {
  const { parseCnkiEndnote } = await import("../src/services/cnki-metadata");
  const result = parseCnkiEndnote(JSON.stringify({ code: 1, data: [{ key: "EndNote", value: ["%0 Thesis<br>%T 双有源桥研究<br>%A 张天晖<br>%D 2019<br>%I 华中科技大学<br>%K DAB;软开关<br>%X 第一行<br>第二行"] }] }), paper().canonical);
  expect(result).toMatchObject({ itemType: "thesis", title: "双有源桥研究", date: "2019", publisher: "华中科技大学", abstract: "第一行 第二行", tags: ["DAB", "软开关"] });
  expect(result.creators).toEqual([{ family: "张", given: "天晖", creatorType: "author" }]);
});

it("temporarily skips searches after a TLS failure and resumes after a minute", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn().mockRejectedValueOnce(new Error("net::ERR_SSL_BAD_RECORD_MAC_ALERT")).mockResolvedValue(html);
    const client = new CnkiClient({ request, verify: vi.fn(async () => {}) });
    await expect(client.search(paper().canonical)).rejects.toThrow("ERR_SSL");
    await expect(client.search(paper().canonical)).rejects.toThrow("已跳过");
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await client.search(paper().canonical)).toEqual(html);
  } finally { vi.useRealTimers(); }
});
