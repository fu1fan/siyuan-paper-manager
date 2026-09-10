import type { MetadataCandidate } from "../../types/import";
import { escapeHtml } from "../dom";

export function candidatePreviewHtml(candidate: MetadataCandidate): string {
  const c = candidate.canonical;
  const types: Record<string, string> = { thesis: "学位论文", journalArticle: "期刊论文", conferencePaper: "会议论文", book: "图书", preprint: "预印本" };
  const field = (label: string, value?: string) => `<div><dt>${label}</dt><dd>${escapeHtml(value || "未识别")}</dd></div>`;
  const authors = c.creators.map(a => [a.family, a.given].filter(Boolean).join(", "));
  const url = c.url ? `<div><dt>网址</dt><dd><details class="paper-manager-paper-url"><summary title="${escapeHtml(c.url)}"><span>${escapeHtml(c.url)}</span></summary><div class="paper-manager-paper-long">${escapeHtml(c.url)}</div></details></dd></div>` : "";
  return `<header class="paper-manager-paper-heading"><div class="paper-manager-paper-badges"><span>${escapeHtml(types[c.itemType] || c.itemType)}</span><span>${escapeHtml(candidate.provider)}</span><span>置信度 ${candidate.confidence.toFixed(2)}</span></div><h3>${escapeHtml(c.title || "未命名文献")}</h3></header>
    <dl class="paper-manager-paper-facts">${field("日期", c.date)}${field(c.itemType === "thesis" ? "学校" : "期刊 / 会议", c.itemType === "thesis" ? c.publisher : c.journal)}${field("DOI", c.doi)}${url}</dl>
    <details class="paper-manager-paper-section"><summary>作者 <span>${authors.length} 位</span></summary><ul>${authors.length ? authors.map(name => `<li>${escapeHtml(name)}</li>`).join("") : "<li>未识别</li>"}</ul></details>
    <details class="paper-manager-paper-section"><summary>摘要 <span>${c.abstract ? `${c.abstract.length} 字符` : "未识别"}</span></summary><div class="paper-manager-paper-long">${escapeHtml(c.abstract || "暂无摘要")}</div></details>
    <details class="paper-manager-paper-section"><summary>关键词 <span>${c.tags.length} 项</span></summary><div class="paper-manager-paper-tags">${c.tags.length ? c.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("") : "未识别"}</div></details>
    ${candidate.reason ? `<details class="paper-manager-paper-section"><summary>识别说明</summary><div class="paper-manager-paper-long">${escapeHtml(candidate.reason)}</div></details>` : ""}`;
}
