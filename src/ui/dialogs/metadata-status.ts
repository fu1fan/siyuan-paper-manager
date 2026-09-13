import type { ExtractionResult } from "../../types/import";
import { escapeHtml } from "../dom";

/** The timer reports elapsed time, never fabricated stage changes. */
export function metadataProgress(signal: AbortSignal, render: (text: string) => void) {
  let stage = "正在准备元数据识别", started = Date.now();
  const paint = () => { if (!signal.aborted) render(`${stage} · 已等待 ${Math.floor((Date.now() - started) / 1000)} 秒`); };
  const timer = setInterval(paint, 1000);
  const stop = () => { clearInterval(timer); signal.removeEventListener("abort", stop); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return { stop, update(text: string) { stage = text; started = Date.now(); paint(); } };
}

export function metadataResultHtml(result: ExtractionResult): string {
  const remote = result.candidates.some(c => !["filename", "pdf-text", "xmp"].includes(c.provider));
  const local = result.candidates.some(c => ["pdf-text", "xmp"].includes(c.provider));
  const summary = remote ? "已获取元数据候选，请核对后应用。" : local ? "已提取 PDF 本地元数据，请核对后应用。" : "仅取得文件名信息，请补充元数据。";
  const warnings = [...new Set(result.warnings)];
  return `<div>${summary}</div>${warnings.length ? `<details><summary>查看在线补充 / 解析详情（${warnings.length} 项）</summary><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul></details>` : ""}`;
}
