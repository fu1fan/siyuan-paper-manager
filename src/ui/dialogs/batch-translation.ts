import { Dialog, showMessage } from "siyuan";
import type { LibraryService, LibraryPaperRecord } from "../../services/library-service";
import type { TranslatorService } from "../../services/translator";
import type { PluginSettings } from "../../types/settings";
import { matchesTranslationPaper, translationBlockReason } from "../../services/batch-translation";
import { escapeHtml } from "../dom";

interface RowState {
  selected: ReadonlySet<string>;
  submitting: boolean;
  expanded: ReadonlySet<string | undefined>;
  blocked?: string;
  error: string;
}

function paperRowHtml(record: LibraryPaperRecord, state: RowState): string {
  const c = record.paper.canonical;
  const authors = c.creators.map(author => `${author.family} ${author.given}`.trim()).join("；");
  return `<article class="paper-manager-batch-row">
    <label class="paper-manager-batch-title"><input type="checkbox" data-id="${escapeHtml(record.docId)}" ${state.selected.has(record.docId) ? "checked" : ""} ${state.blocked || state.submitting ? "disabled" : ""}>
      <strong>${escapeHtml(c.title || record.paper.citekey || "无标题")}</strong></label>
    <span class="paper-manager-batch-state ${state.error ? "ft__error" : "ft__on-surface"}">${escapeHtml(state.blocked || (state.error ? "翻译失败，可重试" : "可翻译"))}</span>
    <div class="paper-manager-batch-info">
      <div class="ft__on-surface">${escapeHtml([authors, c.date, c.journal, record.paper.citekey].filter(Boolean).join(" · "))}</div>
      <div class="paper-manager-batch-projects">${escapeHtml(record.projectNames.join(" / ") || "未分配项目")}${c.doi ? ` · DOI: ${escapeHtml(c.doi)}` : ""}</div>
      <div class="paper-manager-batch-notes">备注：${escapeHtml(record.notes || "暂无备注")}</div>
      ${c.abstract ? `<details data-abstract="${escapeHtml(record.docId)}" ${state.expanded.has(record.docId) ? "open" : ""}><summary class="ft__on-surface">查看摘要</summary><p>${escapeHtml(c.abstract)}</p></details>` : ""}
      ${state.error ? `<div class="ft__error">${escapeHtml(state.error)}</div>` : ""}
      <a href="siyuan://blocks/${escapeHtml(record.docId)}" class="b3-button b3-button--text">打开论文</a>
    </div></article>`;
}
import { errorMessage } from "../../core/errors";

export async function openBatchTranslationDialog(
  libraries: LibraryService, translator: TranslatorService, getSettings: () => PluginSettings, docId: string,
): Promise<void> {
  const library = await libraries.getLibrary(docId);
  let closed = false;
  // Holder keeps the interval reachable from destroyCallback without a read-before-assign.
  const timer: { id?: ReturnType<typeof setInterval> } = {};
  const dialog = new Dialog({
    title: "批量翻译未翻译论文",
    width: "1040px",
    destroyCallback: () => { closed = true; if (timer.id) clearInterval(timer.id); },
    content: `<div class="b3-dialog__content paper-manager-form paper-manager-batch">
      <div class="paper-manager-batch-heading"><strong>${escapeHtml(library.title)}</strong><span class="ft__on-surface">仅列出没有单语或双语译文的论文</span></div>
      <div class="paper-manager-batch-toolbar">
        <label>搜索论文<input class="b3-text-field" data-search placeholder="标题、备注、作者、摘要、DOI…" type="search"></label>
        <label>所属项目<select class="b3-select" data-project><option value="">全部项目</option></select></label>
        <button class="b3-button b3-button--outline" data-refresh>刷新列表</button>
      </div>
      <div class="paper-manager-batch-selection"><span data-count aria-live="polite"></span><span class="fn__flex-1"></span>
        <button class="b3-button b3-button--text" data-select>选择当前可翻译结果</button><button class="b3-button b3-button--text" data-clear>清空选择</button></div>
      <div class="paper-manager-batch-list" data-list></div>
      <div class="paper-manager-batch-footer"><span class="ft__on-surface" data-summary aria-live="polite"></span>
        <div><button class="b3-button b3-button--cancel" data-close>关闭</button><button class="b3-button" data-submit disabled>加入翻译队列</button></div>
      </div>
    </div>`,
  });
  const root = dialog.element;
  const el = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const list = el<HTMLElement>("[data-list]");
  const search = el<HTMLInputElement>("[data-search]");
  const project = el<HTMLSelectElement>("[data-project]");
  const submit = el<HTMLButtonElement>("[data-submit]");
  const refresh = el<HTMLButtonElement>("[data-refresh]");
  const summary = el<HTMLElement>("[data-summary]");
  let records: LibraryPaperRecord[] = [];
  let visible: LibraryPaperRecord[] = [];
  const selected = new Set<string>();
  const outcomes = new Map<string, { state: "success" | "error"; message: string }>();
  let loading = false;
  let submitting = false;
  let loadVersion = 0;
  let translatedCount = 0;

  const reason = (record: LibraryPaperRecord) => {
    const state = translator.taskState(record.docId);
    if (state) return state === "running" ? "正在翻译" : "排队中";
    if (outcomes.get(record.docId)?.state === "success") return "翻译完成";
    return translationBlockReason(record);
  };
  const updateCount = () => {
    const visibleIds = new Set(visible.map(record => record.docId));
    let hidden = 0;
    for (const id of selected) if (!visibleIds.has(id)) hidden += 1;
    const pending = records.reduce((total, record) => total
      + (outcomes.get(record.docId)?.state !== "success" && !record.paper.translation.mono && !record.paper.translation.dual ? 1 : 0), 0);
    el<HTMLElement>("[data-count]").textContent = `未翻译 ${pending} 篇 · 当前 ${visible.length} 条 · 已选 ${selected.size} 篇${hidden ? `（含筛选外 ${hidden} 篇）` : ""}`;
    submit.textContent = submitting ? "正在加入队列…" : `加入翻译队列${selected.size ? `（${selected.size}）` : ""}`;
    submit.disabled = loading || submitting || !selected.size;
  };
  const render = () => {
    if (closed || loading) return;
    for (const record of records) if (reason(record)) selected.delete(record.docId);
    visible = records.filter(record => matchesTranslationPaper(record, search.value, project.value));
    const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>("details[open]")].map(detail => detail.dataset.abstract));
    const scrollTop = list.scrollTop;
    list.innerHTML = visible.length
      ? visible.map(record => paperRowHtml(record, { selected, submitting, expanded, error: outcomes.get(record.docId)?.state === "error" ? outcomes.get(record.docId)!.message : "", blocked: reason(record) })).join("")
      : `<div class="paper-manager-batch-empty">${records.length ? "没有符合筛选条件的论文" : "没有未翻译的论文"}</div>`;
    list.scrollTop = scrollTop;
    updateCount();
  };
  list.addEventListener("change", event => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.id) return;
    if (target.checked) selected.add(target.dataset.id); else selected.delete(target.dataset.id);
    updateCount();
  });
  const load = async () => {
    const version = ++loadVersion;
    outcomes.clear();
    loading = true; refresh.disabled = true; updateCount();
    list.innerHTML = '<div class="paper-manager-batch-empty">正在读取论文、备注和翻译状态…</div>';
    try {
      const all = await libraries.listTranslationPapers(docId);
      if (closed || version !== loadVersion) return;
      translatedCount = all.filter(record => record.paper.translation.mono || record.paper.translation.dual).length;
      records = all.filter(record => !record.paper.translation.mono && !record.paper.translation.dual);
      for (const id of selected) if (!records.some(record => record.docId === id)) selected.delete(id);
      const previous = project.value;
      project.innerHTML = '<option value="">全部项目</option><option value="unassigned">未分配项目</option>' + [...new Set(records.flatMap(record => record.projectNames))].sort((a, b) => a.localeCompare(b, "zh-CN")).map(name => `<option value="project:${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
      project.value = [...project.options].some(option => option.value === previous) ? previous : "";
      summary.textContent = `已排除 ${translatedCount} 篇已有译文的论文。按设置最多同时翻译 ${getSettings().translationConcurrency} 篇；关闭窗口后队列继续运行。`;
      loading = false; render();
    } catch (error) {
      if (closed || version !== loadVersion) return;
      records = []; visible = []; selected.clear();
      list.textContent = `加载失败，请刷新重试：${errorMessage(error)}`;
    } finally {
      if (!closed && version === loadVersion) { loading = false; refresh.disabled = false; updateCount(); }
    }
  };
  search.oninput = render; project.onchange = render;
  el<HTMLButtonElement>("[data-select]").onclick = () => { if (loading || submitting) return; for (const record of visible) if (!reason(record)) selected.add(record.docId); render(); };
  el<HTMLButtonElement>("[data-clear]").onclick = () => { selected.clear(); render(); };
  el<HTMLButtonElement>("[data-close]").onclick = () => dialog.destroy();
  refresh.onclick = () => { if (!submitting) void load(); };
  submit.onclick = async () => {
    if (submitting || loading || !selected.size) return;
    const chosen = records.filter(record => selected.has(record.docId));
    submitting = true; refresh.disabled = true; render();
    let queued = 0;
    let skipped = 0;
    // Re-read every chosen paper before admission; the dialog may have been open
    // for a while. Reads are independent, so run them together and admit in order.
    const readFailures = new Map<string, string>();
    await Promise.all(chosen.map(async record => {
      try {
        record.paper = await libraries.readPaper(record.docId);
        record.loadError = undefined;
      } catch (error) { readFailures.set(record.docId, errorMessage(error)); }
    }));
    for (const record of chosen) {
      const readFailure = readFailures.get(record.docId);
      if (readFailure) {
        skipped++;
        outcomes.set(record.docId, { state: "error", message: `入队失败：${readFailure}` });
        continue;
      }
      const blocked = reason(record);
      if (blocked) { skipped++; selected.delete(record.docId); continue; }
      outcomes.delete(record.docId);
      const completion = translator.translate(record.docId, getSettings(), { untranslatedOnly: true });
      queued++; selected.delete(record.docId);
      void completion.then(() => {
        outcomes.set(record.docId, { state: "success", message: "翻译完成" });
        if (closed) showMessage(`翻译完成：${record.paper.canonical.title}`, 5000, "info");
        render();
      }, (error: unknown) => {
        const message = errorMessage(error);
        outcomes.set(record.docId, { state: "error", message });
        if (closed) showMessage(`翻译失败：${record.paper.canonical.title}：${message}`, 7000, "error");
        render();
      });
    }
    submitting = false; refresh.disabled = false;
    summary.textContent = `已加入 ${queued} 篇${skipped ? `，跳过或失败 ${skipped} 篇（请查看条目状态）` : ""}。关闭窗口后队列继续运行。`;
    render();
  };
  // Update only when queue membership changes so expanded abstracts remain open.
  let queueSnapshot = "";
  timer.id = setInterval(() => {
    const next = records.map(record => translator.taskState(record.docId) ?? "").join(",");
    if (next !== queueSnapshot) { queueSnapshot = next; render(); }
  }, 1000);
  await load();
}
