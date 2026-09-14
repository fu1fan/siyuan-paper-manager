import type { Plugin } from "siyuan";
import type { StatusStore } from "../core/status";
import type { TranslationState } from "../types/status";
import { escapeHtml } from "./dom";

/**
 * 左下角状态栏的翻译进度胶囊（仿内核任务进度样式：标签 + 细进度条）。
 * 单篇显示 CLI 进度，多篇显示整批处理篇数；悬停查看各篇独立进度。
 */
export function mountTranslationStatusBar(plugin: Plugin, status: StatusStore): () => void {
  const element = document.createElement("span");
  element.className = "paper-manager-statusbar";
  element.hidden = true;
  // addStatusBar 仅桌面端可用
  const addStatusBar = (plugin as Plugin & {
    addStatusBar?: (options: { element: HTMLElement; position?: "left" | "right" }) => void;
  }).addStatusBar;
  if (typeof addStatusBar !== "function") return () => {};
  addStatusBar.call(plugin, { element, position: "left" });

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleHide = (delayMs: number) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { element.hidden = true; }, delayMs);
  };
  let previous: TranslationState | undefined;
  const unsubscribe = status.subscribe((status) => {
    if (previous === status.translation) return;
    previous = status.translation;
    render(element, status.translation);
    if (status.translation.state === "success") scheduleHide(5_000);
    else if (status.translation.state === "error") scheduleHide(12_000);
    else if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
  });
  return () => {
    unsubscribe();
    if (hideTimer) clearTimeout(hideTimer);
    element.remove();
  };
}

/** Multi-paper progress measures settled jobs, never a rotating paper's percentage. */
export function translationStatusView(translation: TranslationState): { label: string; title: string; percent?: number } {
  const batch = translation.batch;
  const multi = batch && batch.total > 1;
  const settled = batch ? batch.succeeded + batch.failed + batch.cancelled : 0;
  const counts = batch ? [
    `成功 ${batch.succeeded}`,
    batch.failed ? `失败 ${batch.failed}` : "",
    batch.cancelled ? `取消 ${batch.cancelled}` : "",
  ].filter(Boolean).join(" · ") : "";
  const details = batch?.tasks.map(task => {
    const saving = task.message === "正在保存译稿";
    const progress = task.progress == null ? "准备中" : `${task.progress}%`;
    const message = task.message && !/^翻译中 \d+%$/.test(task.message) ? task.message : "";
    return `${task.title || task.docId}：${saving ? "正在保存译稿" : progress}${message && !saving ? `（${message}）` : ""}`;
  }) ?? [];
  if (translation.state === "running") {
    const active = translation.active ?? 1;
    const queued = translation.queued ?? 0;
    const label = multi
      ? [`翻译 · 已处理 ${settled}/${batch.total}`, `进行 ${active}`, queued ? `等待 ${queued}` : "",
        batch.failed ? `失败 ${batch.failed}` : "", batch.cancelled ? `取消 ${batch.cancelled}` : ""].filter(Boolean).join(" · ")
      : translation.message === "正在保存译稿" ? "翻译 · 正在保存译稿"
        : `翻译中${translation.progress != null ? ` ${translation.progress}%` : " · 准备中"}`;
    return {
      label,
      title: [multi ? `整批已处理 ${settled}/${batch.total} 篇（${counts}）；进度条按已结束篇数计算，包含失败和取消。` : translation.title,
        ...details, ...batch?.errors ?? [],
        !details.length ? translation.message : "",
      ].filter(Boolean).join("\n"),
      percent: multi ? settled / batch.total * 100 : translation.message === "正在保存译稿" ? undefined : translation.progress,
    };
  }
  if (translation.state === "idle") return { label: "", title: "" };
  return {
    label: multi ? `翻译结束 · ${counts} / ${batch.total} 篇` : translation.state === "success" ? "翻译完成" : batch?.cancelled ? "翻译已取消" : "翻译失败",
    title: [translation.state === "success" ? (multi ? `全部 ${batch.total} 篇翻译完成` : `用时 ${(translation.elapsedMs / 1000).toFixed(1)} 秒`) : translation.message,
      ...batch?.errors ?? [],
    ].filter(Boolean).join("\n"),
  };
}

function render(element: HTMLElement, translation: TranslationState): void {
  if (translation.state === "idle") {
    element.hidden = true;
    delete element.dataset.state;
    return;
  }
  const view = translationStatusView(translation);
  if (!element.firstChild) element.append(span("paper-manager-statusbar-label", ""), progressBar(undefined), span("paper-manager-statusbar-popover", ""));
  element.querySelector<HTMLElement>(".paper-manager-statusbar-label")!.textContent = view.label;
  const track = element.querySelector<HTMLElement>(".paper-manager-statusbar-track")!;
  const fill = track.firstElementChild as HTMLElement;
  const multi = Boolean(translation.batch && translation.batch.total > 1);
  track.hidden = translation.state !== "running" || multi;
  const popover = element.querySelector<HTMLElement>(".paper-manager-statusbar-popover")!;
  popover.innerHTML = multi && translation.state === "running" ? (translation.batch?.tasks ?? []).map(task => {
    const value = task.progress == null ? "" : ` style="width:${Math.max(0, Math.min(100, task.progress))}%"`;
    return `<div class="paper-manager-statusbar-task"><div class="paper-manager-statusbar-task-name">${escapeHtml(task.citekey || task.title || task.docId)}</div><div class="paper-manager-statusbar-task-track"><i${value}></i></div><span>${task.progress == null ? "准备中" : `${task.progress}%`}</span></div>`;
  }).join("") : "";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", translation.batch && translation.batch.total > 1 ? "整批已处理篇数比例" : "当前论文翻译进度");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  if (view.percent == null) {
    fill.dataset.indeterminate = "true";
    fill.style.removeProperty("width");
    track.removeAttribute("aria-valuenow");
  } else {
    delete fill.dataset.indeterminate;
    fill.style.width = `${Math.max(0, Math.min(100, view.percent))}%`;
    track.setAttribute("aria-valuenow", String(view.percent));
  }
  element.title = view.title;
  element.dataset.state = translation.state;
  element.hidden = false;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function progressBar(percent: number | undefined): HTMLSpanElement {
  const track = span("paper-manager-statusbar-track", "");
  const fill = span("paper-manager-statusbar-fill", "");
  if (percent == null) fill.dataset.indeterminate = "true";
  else fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  track.append(fill);
  return track;
}
