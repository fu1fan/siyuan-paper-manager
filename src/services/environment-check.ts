import { canUseNode, getNodeRequire, requireNode, type NodeRequire } from "../core/env";
import type { PluginSettings } from "../types/settings";
import type { PluginStatus } from "../types/status";
import { resolveExecutable } from "./translator";

export interface EnvironmentReport {
  desktopNode: { ok: boolean; detail: string };
  connector: { ok: boolean; detail: string };
  pdf2zh: { ok: boolean; detail: string };
  template: { ok: boolean; detail: string };
}

export async function buildEnvironmentReport(settings: PluginSettings, status: PluginStatus): Promise<EnvironmentReport> {
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
      const executable = await resolveExecutable(settings.pdf2zhPath, requireFn);
      const probe = await probePdf2zh(executable, requireFn);
      pdf2zh = `${executable}：${probe.detail}`;
      pdf2zhOk = probe.ok;
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
      detail: status.templateMode === "unknown" ? "尚未渲染模板" : "内置模板渲染器",
    },
  };
}

/** Check CLI startup only; no PDF is translated and no service credentials are passed. */
export function probePdf2zh(
  executable: string,
  requireFn: NodeRequire,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; detail: string }> {
  const childProcess = requireNode<typeof import("node:child_process")>("child_process", requireFn);
  return new Promise((resolve) => {
    try {
      childProcess.execFile(executable, ["--help"], {
        encoding: "utf8", shell: false, windowsHide: true,
        timeout: timeoutMs, maxBuffer: 64 * 1024,
      }, (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, detail: "启动检查通过（未验证模型下载及真实翻译）" });
          return;
        }
        const code = error.code;
        const reason = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "启动检查输出超过64 KiB限制"
          : error.killed ? `启动检查超时（${timeoutMs / 1000}秒）`
          : code === "ENOENT" ? "程序或其依赖的解释器不存在"
          : typeof code === "number" ? `启动检查退出码 ${code}`
          : `启动失败：${error.message}`;
        resolve({ ok: false, detail: `${reason}${stderr ? `：${stderr.trim().slice(-1000)}` : ""}` });
      });
    } catch (error) {
      resolve({ ok: false, detail: `启动失败：${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
