import type { PaperCanonical } from "../types/paper";

export type CnkiRegion = "mainland" | "oversea";
export interface CnkiResponse { status: number; url: string; text: string }
export interface CnkiRequest { url: string; method: "GET" | "POST"; body?: string; headers: Record<string, string> }
export interface CnkiTransport {
  request(request: CnkiRequest, signal?: AbortSignal): Promise<CnkiResponse>;
  verify(url: string, signal?: AbortSignal): Promise<void>;
}
const databases = "YSTT4HG0,LSTPFY1C,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,EMRPGLPA,NLBO1Z6R,NN3FJMUV";
const overseasDatabases = "CJFQ,CDMD,CIPD,CCND,CYFD,CCJD,BDZK,CISD,CJFN";

export function cnkiHome(region: CnkiRegion): string {
  return region === "oversea" ? "https://chn.oversea.cnki.net/kns/defaultresult/index" : "https://kns.cnki.net/kns8s/defaultresult/index";
}
export function trustedCnkiUrl(value: string, base = cnkiHome("mainland")): string {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !(url.hostname === "cnki.net" || url.hostname.endsWith(".cnki.net")) || url.username || url.password) {
    throw new Error("知网返回了不受支持的跳转地址");
  }
  return url.href;
}

/** Wire format of the CNKI search form; the local page must not fetch this cross-origin. */
export function cnkiSearchRequest(local: PaperCanonical, region: CnkiRegion): CnkiRequest {
  const quote = (text: string) => text.replace(/['\r\n]/g, " ").trim();
  const author = local.creators.find((creator) => creator.creatorType === "author") ?? local.creators[0];
  const expression = `TI %= '${quote(local.title)}'${author ? ` AND AU='${quote(author.family + author.given)}'` : ""}`;
  const item = region === "mainland"
    ? { Key: "Expert", Title: "", Logic: 0, Field: "EXPERT", Operator: 0, Value: expression, Value2: "" }
    : { Key: "Expert", Title: "", Logic: 0, Name: "", Operate: "", Value: expression, ExtendType: 12, ExtendValue: "中英文对照", Value2: "", BlurType: "" };
  const query = {
    Platform: "", ...(region === "mainland" ? { Resource: "CROSSDB", Classid: "WD0FTY92", Products: "" } : { DBCode: "CFLS" }),
    QNode: { QGroup: [
      { Key: "Subject", Title: "", Logic: region === "mainland" ? 0 : 4, Items: [item], ChildItems: [] },
      { Key: "ControlGroup", Title: "", Logic: region === "mainland" ? 0 : 1, Items: [], ChildItems: [] },
    ] },
    ExScope: "1", KuaKuCode: region === "mainland" ? databases : overseasDatabases,
    ...(region === "mainland" ? { SearchType: 4, Rlang: "CHINESE", SearchFrom: 1 } : { CodeLang: "" }),
  };
  const body = new URLSearchParams(region === "mainland" ? {
    boolSearch: "true", QueryJson: JSON.stringify(query), pageNum: "1", pageSize: "20", sortField: "", sortType: "",
    dstyle: "listmode", productStr: databases + ",", aside: `(${expression.replaceAll("'", "&#39;")})`,
    searchFrom: "资源范围：总库;++中英文扩展;++时间范围：更新时间：不限;++", CurPage: "1",
  } : {
    IsSearch: "true", QueryJson: JSON.stringify(query), PageName: "AdvSearch", DBCode: "CFLS", KuaKuCodes: overseasDatabases,
    CurPage: "1", RecordsCntPerPage: "20", CurDisplayMode: "listmode", CurrSortField: "", CurrSortFieldType: "desc", IsSentenceSearch: "false", Subject: "",
  });
  return {
    url: region === "mainland" ? "https://kns.cnki.net/kns8s/brief/grid" : "https://chn.oversea.cnki.net/kns/Brief/GetGridTableHtml",
    method: "POST", body: body.toString(), headers: {
      Accept: "text/html, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest", "Accept-Language": "zh-CN,zh;q=0.9",
      Origin: new URL(cnkiHome(region)).origin, Referer: cnkiHome(region),
    },
  };
}

export function cnkiChallenge(response: CnkiResponse): string | undefined {
  let target: string | undefined;
  if (/\/(?:verify|captcha)(?:\/|\?)/i.test(response.url)) target = response.url;
  if (response.status === 403) {
    try { const value = JSON.parse(response.text) as { message?: unknown }; if (typeof value.message === "string" && /^https:\/\//.test(value.message)) target = value.message; }
    catch { /* HTML access-denied page */ }
    target ??= response.url;
  }
  if (/<title[^>]*>[^<]*(?:验证|captcha)|captchaType|blockPuzzle|请完成.{0,12}验证/i.test(response.text)) target ??= response.url;
  return target ? trustedCnkiUrl(target) : undefined;
}

/** Shared per plugin: cache verified sessions and serialize challenges/searches. */
export class CnkiClient {
  private unavailableUntil = 0;
  private readyAt = new Map<CnkiRegion, number>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly transport: CnkiTransport) {}

  search(local: PaperCanonical, region: CnkiRegion = "mainland", signal?: AbortSignal): Promise<CnkiResponse> {
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (Date.now() < this.unavailableUntil) throw new Error("知网连接暂不可用，已跳过自动重试；一分钟后恢复");
      if (Date.now() - (this.readyAt.get(region) ?? 0) > 5 * 60_000) {
        await this.transport.verify(cnkiHome(region), signal);
        this.readyAt.set(region, Date.now());
      }
      const request = cnkiSearchRequest(local, region);
      return this.requestVerified(request, region, signal);
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async requestVerified(request: CnkiRequest, region: CnkiRegion, signal?: AbortSignal): Promise<CnkiResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      let response: CnkiResponse;
      try { response = await this.transport.request(request, signal); }
      catch (error) {
        if (!signal?.aborted && error instanceof Error && /ERR_SSL|ERR_CONNECTION|ERR_TIMED_OUT|请求超时/.test(error.message)) {
          this.unavailableUntil = Date.now() + 60_000;
        }
        throw error;
      }
      const challenge = cnkiChallenge(response);
      if (challenge) {
        this.readyAt.delete(region);
        if (attempt) throw new Error("知网验证尚未通过，请稍后重试");
        await this.transport.verify(challenge, signal);
        this.readyAt.set(region, Date.now());
        request = { ...request, headers: { ...request.headers, Referer: challenge } };
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`知网 HTTP ${response.status}`);
      return response;
    }
    throw new Error("知网检索未完成");
  }
}
