import { canUseNode, getNodeRequire, requireNode } from "../core/env";
import type { PluginSettings } from "../types/settings";
import type { PluginStatus } from "../types/status";
import { resolveExecutable } from "./translator";

export interface EnvironmentReport {
  desktopNode: { ok: boolean; detail: string };
  connector: { ok: boolean; detail: string };
  pdf2zh: { ok: boolean; detail: string };
  template: { ok: boolean; detail: string };
}

export function buildEnvironmentReport(settings: PluginSettings, status: PluginStatus): EnvironmentReport {
  const requireFn = getNodeRequire();
  let nodeDetail = "window.require 不可用";
  let nodeOk = false;
  if (canUseNode() && requireFn) {
    try {
      requireNode("http", requireFn);
      requireNode("fs", requireFn);
      nodeOk = true;
      nodeDetail = "桌面端 Node 模块可用";
    } catch (error) {
      nodeDetail = error instanceof Error ? error.message : String(error);
    }
  }
  let pdf2zh = "未检测";
  let pdf2zhOk = false;
  if (requireFn) {
    try {
      pdf2zh = resolveExecutable(settings.pdf2zhPath, requireFn);
      pdf2zhOk = true;
    } catch (error) {
      pdf2zh = error instanceof Error ? error.message : String(error);
    }
  }
  const connectorOk = status.connector.state === "listening";
  const connectorDetail = status.connector.state === "listening"
    ? `正在监听 127.0.0.1:${status.connector.port}`
    : status.connector.state === "error"
      ? status.connector.message
      : "未启动";
  return {
    desktopNode: { ok: nodeOk, detail: nodeDetail },
    connector: { ok: connectorOk, detail: connectorDetail },
    pdf2zh: { ok: pdf2zhOk, detail: pdf2zh },
    template: {
      ok: status.templateMode !== "unknown",
      detail: status.templateMode === "unknown" ? "尚未执行真实模板探针" : status.templateMode === "native" ? "原生模板" : "内置回退渲染器",
    },
  };
}
