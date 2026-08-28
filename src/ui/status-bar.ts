import type { Plugin } from "siyuan";
import type { StatusStore } from "../core/status";
import type { PluginStatus } from "../types/status";

export function installStatusBar(plugin: Plugin, store: StatusStore, onClick: () => void): () => void {
  const element = document.createElement("span");
  element.className = "status-bar__item paper-manager-status";
  element.title = "点击运行论文管理环境自检";
  element.addEventListener("click", onClick);
  plugin.addStatusBar({ element, position: "right" });
  return store.subscribe((status) => render(element, status));
}

function render(element: HTMLElement, status: PluginStatus): void {
  const connector = status.connector.state === "listening"
    ? `Zotero ${status.connector.port}`
    : status.connector.state === "error"
      ? "Zotero 错误"
      : "Zotero 停止";
  const translation = status.translation.state === "running"
    ? `翻译${status.translation.progress == null ? "中" : ` ${status.translation.progress}%`}`
    : status.translation.state === "error"
      ? "翻译失败"
      : "";
  element.textContent = `论文管理 · ${connector}${translation ? ` · ${translation}` : ""}`;
  element.dataset.state = status.connector.state === "error" || status.translation.state === "error" ? "error" : "ok";
}
