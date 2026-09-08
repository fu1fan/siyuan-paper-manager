import type { Plugin } from "siyuan";
import type { StatusStore } from "../core/status";
import type { TranslationState } from "../types/status";

/**
 * 左下角状态栏的翻译进度胶囊（仿内核任务进度样式：标签 + 细进度条）。
 * 进度来自 pdf2zh 文本输出解析；多篇排队时显示当前进度与队列长度。
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
  const unsubscribe = status.subscribe((status) => {
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

function render(element: HTMLElement, translation: TranslationState): void {
  switch (translation.state) {
    case "running": {
      const percent = translation.progress;
      const queued = translation.queued ?? 0;
      const label = [
        `翻译中${percent != null ? ` ${percent}%` : ""}`,
        (translation.active ?? 1) > 1 ? `并行 ${translation.active}` : "",
        queued > 0 ? `队列 ${queued}` : "",
      ].filter(Boolean).join(" · ");
      element.replaceChildren(...[
        span("paper-manager-statusbar-label", label),
        progressBar(percent),
      ]);
      element.title = translation.message ?? "pdf2zh 正在翻译";
      element.dataset.state = "running";
      element.hidden = false;
      break;
    }
    case "success":
      element.replaceChildren(span("paper-manager-statusbar-label", "翻译完成"));
      element.title = `用时 ${(translation.elapsedMs / 1000).toFixed(1)} 秒`;
      element.dataset.state = "success";
      element.hidden = false;
      break;
    case "error":
      element.replaceChildren(span("paper-manager-statusbar-label", "翻译失败"));
      element.title = translation.message;
      element.dataset.state = "error";
      element.hidden = false;
      break;
    default:
      element.hidden = true;
      delete element.dataset.state;
  }
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
