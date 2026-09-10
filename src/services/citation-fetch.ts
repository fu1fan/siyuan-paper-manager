// Citation-js is used only for local BibTeX; keep its Node HTTP dependencies out of the browser bundle.
export const Headers = globalThis.Headers;
export default function citationFetch(): never { throw new Error("BibTeX 解析不允许发起网络请求"); }
