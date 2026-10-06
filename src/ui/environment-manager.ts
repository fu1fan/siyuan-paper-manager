import { pdf2zhActivity } from "../services/environment-activity";
import { Dialog, showMessage, confirm } from "siyuan";
import type { Plugin } from "siyuan";
import { canUseNode, getNodeRequire } from "../core/env";
import type { PluginSettings } from "../types/settings";
import { DOWNLOAD_PRESETS } from "../services/download-presets";
import { isPdf2zhDependencyError, inspectUvToolPdf2zh, manageUvToolPdf2zh, type UvToolPdf2zh, type UvToolAction, detectPdf2zh, findUv, installPdf2zh, installUv, inspectPdf2zh, PDF2ZH_COMPAT_REQUIREMENT, resolvePdf2zh, scanPython, validateDownloadSources, validateDeploymentPython } from "../services/pdf2zh-deployment";
import { resolveExecutable } from "../services/translator";
import { probePdf2zh } from "../services/environment-check";
import { errorMessage } from "../core/errors";
import { escapeHtml } from "./dom";

export const ENVIRONMENT_KEYS = ["pythonPath", "pdf2zhPath", "pdf2zhIndexUrl", "pdf2zhPythonMirror", "pdf2zhUvInstallerUrl", "pdf2zhUvGithubUrl", "pdf2zhUvDownloadUrl"] as const;
export function environmentValues(settings: PluginSettings): Pick<PluginSettings, typeof ENVIRONMENT_KEYS[number]> {
  return Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, settings[key]])) as Pick<PluginSettings, typeof ENVIRONMENT_KEYS[number]>;
}

/** One retained view per plugin: closing the dialog never owns or cancels the job. */
export class EnvironmentManager {
  private draft: PluginSettings;
  private deployBusy = false;
  private deployAbort?: AbortController;
  private pythonChoiceRevision = 0;
  private toolSelection?: UvToolPdf2zh;
  private checkedExecutable?: string;
  private probeOk = false;
  private probeDetail = "";
  private dirty = false;
  private root?: HTMLElement;
  private dialog?: Dialog;
  private statusBar?: HTMLButtonElement;
  private observer?: MutationObserver;
  private disposed = false;
  private pendingResult = false;

  constructor(private readonly getSettings: () => PluginSettings,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
    private readonly isTranslationRunning: () => boolean = () => false) {
    this.draft = structuredClone(getSettings());
  }

  mountStatusBar(plugin: Plugin): void {
    if (!canUseNode()) return;
    this.statusBar = document.createElement("button");
    this.statusBar.type = "button";
    this.statusBar.className = "paper-manager-statusbar paper-manager-environment-status";
    this.statusBar.hidden = true;
    this.statusBar.addEventListener("click", () => this.open());
    plugin.addStatusBar({ element: this.statusBar, position: "left" });
  }

  open(): void {
    if (this.disposed || !canUseNode()) return;
    if (this.dialog) { this.dialog.element.querySelector<HTMLElement>("[data-env-close]")?.focus(); return; }
    if (!this.root) {
      this.draft = structuredClone(this.getSettings());
      this.root = document.createElement("div");
      this.root.className = "paper-manager-form paper-manager-environment";
      this.root.innerHTML = this.html();
      this.bindEvents(this.root);
      this.observer = new MutationObserver(() => this.renderStatusBar());
      for (const element of this.root.querySelectorAll("[data-deploy-status], [data-pdf2zh-status]")) {
        this.observer.observe(element, { childList: true, subtree: true, characterData: true });
      }
    }
    if (!this.deployBusy && !this.dirty) {
      this.draft = structuredClone(this.getSettings());
      for (const key of ENVIRONMENT_KEYS) {
        const input = this.root.querySelector<HTMLInputElement>(`[data-key=${key}]`);
        if (input) input.value = this.draft[key] ?? "";
      }
      this.syncPythonControls(this.root);
    }
    const preserveResult = this.pendingResult;
    this.pendingResult = false;
    this.dialog = new Dialog({ title: "翻译环境", width: "min(680px, calc(100vw - 24px))",
      content: '<div data-environment-host></div>',
      destroyCallback: () => { this.root?.remove(); this.dialog = undefined; this.renderStatusBar(); },
    });
    this.dialog.element.querySelector("[data-environment-host]")!.append(this.root);
    this.dialog.element.querySelector(".b3-dialog__container")?.classList.add("paper-manager-environment-dialog");
    this.renderStatusBar();
    if (!this.deployBusy) {
      if (preserveResult) void this.withDeployBusy(this.root, () => this.refreshPdf2zh(this.root!));
      else void this.scanPdf2zh(this.root);
    }
  }

  destroy(): void {
    this.disposed = true;
    this.deployAbort?.abort();
    this.observer?.disconnect();
    this.dialog?.destroy();
    this.statusBar?.remove();
    this.root = undefined;
  }

  private renderStatusBar(): void {
    if (!this.statusBar || this.disposed) return;
    const message = this.root?.querySelector<HTMLElement>("[data-deploy-status]");
    const detail = message && !message.hidden ? message.textContent : this.root?.querySelector("[data-pdf2zh-status]")?.textContent;
    this.statusBar.hidden = Boolean(this.dialog) || (!this.deployBusy && !this.pendingResult);
    this.statusBar.dataset.state = this.deployBusy ? "running" : "finished";
    this.statusBar.textContent = this.deployBusy ? `翻译环境 · ${detail || "正在检查…"}` : "翻译环境 · 查看操作结果";
    this.statusBar.title = `${detail || "翻译环境"}。点击恢复环境管理窗口`;
  }

  private async persist(activate = false): Promise<void> {
    if (this.disposed) return;
    validateDownloadSources(this.draft);
    await this.onSave({ ...this.getSettings(), ...environmentValues(this.draft),
      pdf2zhPath: activate ? this.draft.pdf2zhPath : this.getSettings().pdf2zhPath });
    this.dirty = this.draft.pdf2zhPath !== this.getSettings().pdf2zhPath;
    if (this.root) this.updateManagementControls(this.root);
  }

  private bindEvents(root: HTMLElement): void {
    const capture = (event: Event) => {
      const input = event.target as HTMLInputElement;
      const key = input.dataset.key;
      if (!ENVIRONMENT_KEYS.some(item => item === key)) return;
      (this.draft as unknown as Record<string, unknown>)[key!] = input.value;
      this.dirty = true;
      if (key === "pdf2zhPath") {
        this.toolSelection = undefined;
        this.checkedExecutable = undefined;
        this.probeOk = false;
        root.querySelector<HTMLElement>("[data-pdf2zh-status]")!.textContent = "路径已修改，尚未检测或启用。点击「验证并使用此环境」。";
        root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!.hidden = true;
        this.updateManagementControls(root);
      }
    };
    root.addEventListener("input", capture);
    root.addEventListener("change", capture);
    root.querySelector("[data-env-close]")?.addEventListener("click", () => this.dialog?.destroy());
    root.querySelector<HTMLButtonElement>("[data-env-save]")?.addEventListener("click", () => {
      void this.withDeployBusy(root, async () => {
        try { await this.persist(); showMessage("下载源与新安装选项已保存；切换环境请点击「验证并使用此环境」"); }
        catch (error) { showMessage(`保存失败：${errorMessage(error)}`, 5000, "error"); }
      });
    });
    root.querySelector<HTMLButtonElement>("[data-env-activate]")?.addEventListener("click", () => void this.activateEnvironment(root));
    root.querySelector<HTMLSelectElement>("[data-python-select]")?.addEventListener("change", event => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "__custom__") void this.selectPython(root, value);
      else root.querySelector<HTMLInputElement>("[data-python-manual]")?.focus();
    });
    root.querySelector<HTMLButtonElement>("[data-scan-python]")?.addEventListener("click", () => void this.scanPython(root));
    root.querySelector<HTMLButtonElement>("[data-scan-pdf2zh]")?.addEventListener("click", () => void this.scanPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-uninstall-pdf2zh]")?.addEventListener("click", () => {
      const target = this.toolSelection;
      if (!target || this.deployBusy) return;
      confirm("卸载 PDF2ZH", `将卸载 ${escapeHtml(target.executable)}（uv tool 目录：${escapeHtml(target.toolDir)}）。终端等其他应用也将无法使用该安装，已有译稿保留。`,
        () => void this.manageTool(root, "uninstall", target));
    });
    root.querySelector<HTMLButtonElement>("[data-upgrade-pdf2zh]")?.addEventListener("click", () => void this.manageTool(root, "upgrade"));
    root.querySelector<HTMLButtonElement>("[data-install-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-cancel-install]")?.addEventListener("click", () => this.deployAbort?.abort());
    root.querySelector<HTMLButtonElement>("[data-repair-pdf2zh]")?.addEventListener("click", () => void this.manageTool(root, "repair"));
    root.querySelector<HTMLButtonElement>("[data-apply-download-preset]")?.addEventListener("click", () => {
      const id = root.querySelector<HTMLSelectElement>("[data-download-preset]")?.value;
      const preset = DOWNLOAD_PRESETS.find(item => item.id === id);
      if (!preset) return;
      Object.assign(this.draft, preset.values);
      this.dirty = true;
      for (const [key, value] of Object.entries(preset.values)) {
        const input = root.querySelector<HTMLInputElement>(`[data-key=${key}]`);
        if (input) input.value = value;
      }
      const status = root.querySelector<HTMLElement>("[data-download-preset-status]");
      if (status) status.textContent = `已填入：${preset.label}。保存设置后供下次使用。`;
    });
    const manualPython = root.querySelector<HTMLInputElement>("[data-python-manual]");
    manualPython?.addEventListener("input", () => this.updatePythonChoice(root, manualPython.value));
    manualPython?.addEventListener("change", () => void this.selectPython(root, manualPython.value));
  }
  private html(): string {
    return `<div class="paper-manager-environment-body"><div class="paper-manager-environment-heading"><h2>PDF2ZH</h2><p class="paper-manager-hint">检测、接入或管理本机 PDF2ZH 环境。</p></div>
      <p class="paper-manager-hint" data-active-path></p><div class="paper-manager-preview" data-pdf2zh-status role="status">正在检查环境…</div>
      
      <div data-pdf2zh-existing hidden><div class="paper-manager-preview" data-pdf2zh-detail></div></div>
      <div class="paper-manager-preview" data-deploy-status role="status" aria-live="polite" hidden></div>
      <div data-pdf2zh-deploy>
        <p class="paper-manager-hint" data-install-hint>新安装会自动准备 uv、Python 3.12 和 PDF2ZH，并启用独立环境。已有安装可填写路径后验证并启用。</p>
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-env-activate hidden>验证并使用此环境</button><button type="button" class="b3-button" data-install-pdf2zh>安装翻译环境</button><button type="button" class="b3-button b3-button--outline" data-scan-pdf2zh>重新检测</button><button type="button" class="b3-button b3-button--outline" data-upgrade-pdf2zh hidden disabled>升级</button><button type="button" class="b3-button b3-button--text" data-repair-pdf2zh hidden disabled>修复安装</button><button type="button" class="b3-button b3-button--text" data-uninstall-pdf2zh hidden disabled>卸载</button><button type="button" class="b3-button b3-button--outline" data-cancel-install hidden>取消安装</button></div>
        <details data-download-sources><summary>自定义下载源</summary>
          <p class="paper-manager-hint">留空沿用 uv 默认或已有环境配置。包索引不影响 Python 和 uv 下载；以下地址分别设置。安装时立即使用当前填写值，点击「保存安装选项」后供下次使用。</p>
          <div class="paper-manager-actions"><select class="b3-select" data-download-preset aria-label="下载源预设"><option value="">选择镜像预设…</option>${DOWNLOAD_PRESETS.map(item => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join("")}</select><button type="button" class="b3-button b3-button--outline" data-apply-download-preset>填入预设</button></div>
          <p class="paper-manager-hint" data-download-preset-status role="status">清华和北外仅替换包索引；中科大替换全部下载源。中科大仅镜像最新发布，缺失的 Python 文件会转回 GitHub。</p>
          ${textField("Python 包索引", "pdf2zhIndexUrl", this.draft.pdf2zhIndexUrl ?? "", "PEP 503 索引，例如 https://pypi.org/simple")}
          ${textField("Python 下载镜像", "pdf2zhPythonMirror", this.draft.pdf2zhPythonMirror ?? "", "替换 https://github.com/astral-sh/python-build-standalone/releases/download 的根地址；须保留日期与文件名目录结构。")}
          ${textField("uv 安装脚本目录", "pdf2zhUvInstallerUrl", this.draft.pdf2zhUvInstallerUrl ?? "", "默认 https://astral.sh/uv；自定义目录须提供 install.sh 和 install.ps1。中科大预设已适配 uv-installer 脚本。")}
          ${textField("uv 发布文件目录", "pdf2zhUvDownloadUrl", this.draft.pdf2zhUvDownloadUrl ?? "", "可直接提供对应版本的 uv 压缩包目录；优先于下方 GitHub 镜像。中科大预设会自动填入。")}
          ${textField("uv GitHub 镜像", "pdf2zhUvGithubUrl", this.draft.pdf2zhUvGithubUrl ?? "", "替换 https://github.com 的根地址；镜像须提供 astral-sh/uv 发布文件。仅缺少 uv 时使用。")}
        </details>
        <details><summary>高级选项 · 新安装使用的 Python</summary><p class="paper-manager-hint">仅影响新安装。升级和修复保留所选环境原有的 Python。</p>
        <label class="paper-manager-field">${fieldInfo("部署 Python")}<div class="paper-manager-python-choice"><select class="b3-select" data-python-select aria-label="部署 Python"><option value="">自动（Python 3.12）</option><option value="__custom__">自定义路径</option></select><button type="button" class="b3-button b3-button--outline" data-scan-python>扫描</button></div></label>
        <label class="paper-manager-field">${fieldInfo("手动 Python 路径")}<input class="b3-text-field" data-python-manual value="${escapeHtml(this.draft.pythonPath)}" placeholder="留空自动选择，或填写 /path/to/python"></label>
        </details>
        
      </div>
      <details><summary>使用已有安装</summary>${textField("pdf2zh 路径", "pdf2zhPath", this.draft.pdf2zhPath, "填写可执行文件路径后，点击「验证并使用此环境」。仅保存安装选项不会切换当前环境。")} </details>
      <details class="paper-manager-term" data-term hidden><summary>终端输出</summary><pre data-term-log></pre></details></div><footer class="paper-manager-environment-footer"><span class="paper-manager-hint">关闭可保留进度及未保存修改</span><button type="button" class="b3-button b3-button--outline" data-env-save>保存安装选项</button><button type="button" class="b3-button b3-button--text" data-env-close>关闭</button></footer>`;
  }
  private updateManagementControls(root: HTMLElement): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-upgrade-pdf2zh], [data-repair-pdf2zh], [data-uninstall-pdf2zh]")) {
      button.disabled = this.deployBusy || !this.toolSelection;
      button.hidden = !this.toolSelection;
    }
    const active = root.querySelector<HTMLElement>("[data-active-path]");
    if (active) active.textContent = `当前翻译使用：${this.getSettings().pdf2zhPath || "pdf2zh（自动查找）"}`;
    const activate = root.querySelector<HTMLButtonElement>("[data-env-activate]");
    if (activate) {
      activate.hidden = this.probeOk && this.checkedExecutable === this.getSettings().pdf2zhPath;
      if (!this.checkedExecutable && (!this.draft.pdf2zhPath.trim() || this.draft.pdf2zhPath === "pdf2zh")) activate.hidden = true;
      activate.disabled = this.deployBusy;
    }
    const install = root.querySelector<HTMLButtonElement>("[data-install-pdf2zh]");
    if (install) install.hidden = Boolean(this.toolSelection);
    const hint = root.querySelector<HTMLElement>("[data-install-hint]");
    if (hint) hint.hidden = Boolean(this.toolSelection);
  }

  /** 部署操作（扫描/安装/升级/卸载）互斥：进行中禁用相关按钮，防止并发写同一 uv 环境。 */
  private async withDeployBusy(root: HTMLElement, work: () => Promise<void>): Promise<void> {
    if (this.deployBusy) return;
    if (this.disposed) return;
    this.deployBusy = true;
    this.renderStatusBar();
    const buttons = root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      "[data-env-activate], [data-env-save], [data-scan-pdf2zh], [data-uninstall-pdf2zh], [data-upgrade-pdf2zh], [data-repair-pdf2zh], [data-install-pdf2zh], [data-scan-python], [data-python-select], [data-python-manual], [data-key=pdf2zhPath], [data-download-sources] input, [data-download-sources] select, [data-download-sources] button",
    );
    for (const button of buttons) button.disabled = true;
    try {
      await work();
    } finally {
      this.deployBusy = false;
      this.pendingResult = !this.dialog;
      this.renderStatusBar();
      for (const button of buttons) button.disabled = false;
      this.updateManagementControls(root);
    }
  }

  /** 部署区可展开的终端输出；保留最近 500 行并滚动到底。 */
  private deployTerminal(root: HTMLElement): { append: (line: string) => void; clear: () => void; show: () => void } {
    const details = root.querySelector<HTMLDetailsElement>("[data-term]")!;
    const pre = root.querySelector<HTMLElement>("[data-term-log]")!;
    const append = (line: string) => {
      details.hidden = false;
      const lines = pre.textContent ? pre.textContent.split("\n") : [];
      lines.push(line);
      if (lines.length > 500) lines.splice(0, lines.length - 500);
      pre.textContent = lines.join("\n");
      pre.scrollTop = pre.scrollHeight;
    };
    return {
      append,
      clear: () => { pre.textContent = ""; },
      show: () => { details.hidden = false; details.open = true; },
    };
  }

  private async scanPdf2zh(root: HTMLElement): Promise<void> {
    await this.withDeployBusy(root, async () => {
      const progress = root.querySelector<HTMLElement>("[data-deploy-status]");
      if (progress) progress.hidden = true;
      await this.refreshPdf2zh(root);
    });
  }

  private async refreshPdf2zh(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!;
    status.textContent = "正在检查翻译环境…";
    const choiceRevision = this.pythonChoiceRevision;
    const configured = this.draft.pdf2zhPath;
    this.toolSelection = undefined;
    this.checkedExecutable = undefined;
    this.probeOk = false;
    root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!.hidden = true;
    try {
      const installed = await inspectPdf2zh(undefined, this.draft.pythonPath || undefined);
      const explicit = configured.trim() && configured.trim() !== "pdf2zh";
      const executable = explicit ? await resolveExecutable(configured, getNodeRequire()!)
        : installed?.executable ?? await detectPdf2zh();
      if (this.disposed || choiceRevision !== this.pythonChoiceRevision || configured !== this.draft.pdf2zhPath) return;
      const existing = root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!;
      existing.hidden = !executable;
      // The Python choice applies only to future new installations.
      root.querySelector<HTMLElement>("[data-pdf2zh-deploy]")!.hidden = false;
      if (!executable) {
        status.textContent = "未找到 pdf2zh，可直接安装独立环境。";
        return;
      }
      const tool = await inspectUvToolPdf2zh(executable);
      if (this.disposed || choiceRevision !== this.pythonChoiceRevision || configured !== this.draft.pdf2zhPath) return;
      this.toolSelection = tool ?? undefined;
      this.checkedExecutable = executable;
      root.querySelector<HTMLElement>("[data-pdf2zh-detail]")!.textContent =
        `${tool?.version ? `版本 ${tool.version} · ` : ""}${executable}`;
      this.updateManagementControls(root);
      const probe = await probePdf2zh(executable, getNodeRequire()!, 15_000, {
        autoRepair: false,
      });
      if (this.disposed || choiceRevision !== this.pythonChoiceRevision || configured !== this.draft.pdf2zhPath) return;
      this.probeDetail = probe.detail;
      if (!probe.ok) throw new Error(probe.detail);
      this.probeOk = true;
      if (!explicit) {
        this.draft.pdf2zhPath = executable;
        const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
        if (input) input.value = executable;
      }
      const enabled = executable === this.getSettings().pdf2zhPath;
      status.textContent = `${enabled ? "当前环境" : "检测到环境，尚未启用"}：启动检查通过（未验证模型下载和真实翻译）。${this.toolSelection
        ? "uv tool 独立环境，可升级、修复或卸载。" : "请通过原安装方式升级、修复或卸载。"}`;
      root.querySelector<HTMLElement>("[data-pdf2zh-detail]")!.textContent =
        `${this.toolSelection?.version ? `版本 ${this.toolSelection.version} · ` : ""}${executable}`;

    } catch (error) {
      status.textContent = `检查失败：${errorMessage(error)}${this.toolSelection ? "；可尝试修复安装。" : ""}`;
    } finally {
      this.updateManagementControls(root);
    }
  }

  private async activateEnvironment(root: HTMLElement): Promise<void> {
    await this.withDeployBusy(root, async () => {
      const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
      status.hidden = false;
      try {
        await this.refreshPdf2zh(root);
        if (!this.probeOk || !this.checkedExecutable) throw new Error("环境未通过检查，当前翻译环境保持不变");
        this.draft.pdf2zhPath = this.checkedExecutable;
        await this.persist(true);
        status.textContent = "已启用此环境；之后提交的翻译任务将使用该路径。";
        await this.refreshPdf2zh(root);
      } catch (error) { status.textContent = errorMessage(error); }
    });
  }

  private async manageTool(root: HTMLElement, action: UvToolAction, selected = this.toolSelection): Promise<void> {
    if (!selected) {
      root.querySelector<HTMLElement>("[data-pdf2zh-status]")!.textContent = "请先检测并选择 uv tool 环境";
      return;
    }
    await this.withDeployBusy(root, async () => {
      const label = action === "uninstall" ? "卸载" : action === "repair" ? "修复安装" : "升级";
      const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
      const cancel = root.querySelector<HTMLButtonElement>("[data-cancel-install]");
      const term = this.deployTerminal(root);
      status.hidden = false; status.textContent = `正在${label} PDF2ZH…`; term.clear();
      this.deployAbort = new AbortController();
      if (cancel) { cancel.hidden = false; cancel.textContent = `取消${label}`; }
      let release: (() => void) | undefined;
      try {
        release = pdf2zhActivity.acquireMutation();
        if (this.isTranslationRunning()) throw new Error("有翻译任务正在执行或排队，请完成后再管理 pdf2zh");
        validateDownloadSources(this.draft);
        const executable = selected.executable;
        if (!executable) throw new Error("未找到当前 pdf2zh，请重新检测");
        const before = await inspectUvToolPdf2zh(executable);
        if (!before || before.toolDir !== selected.toolDir || before.binDir !== selected.binDir) throw new Error("环境位置已变化，请重新检测后操作");
        let activeExecutable: string | undefined;
        try { activeExecutable = await resolveExecutable(this.getSettings().pdf2zhPath, getNodeRequire()!); } catch { /* current config may already be broken */ }
        if (action === "repair") {
          const diagnosis = await probePdf2zh(executable, getNodeRequire()!);
          this.probeDetail = diagnosis.detail;
        }
        const result = await manageUvToolPdf2zh(executable, action, { ...this.draft, repairDependency: action === "repair" && isPdf2zhDependencyError(this.probeDetail), signal: this.deployAbort.signal }, undefined, line => term.append(line));
        if (this.deployAbort.signal.aborted || this.disposed) throw new Error(`${label}已取消，请重新检测环境状态`);
        if (result.code !== 0) throw new Error(`${label}失败：${result.stderr || "请查看日志"}`);
        if (cancel) cancel.hidden = true;
        if (action === "uninstall") {
          this.toolSelection = undefined;
          this.draft.pdf2zhPath = "pdf2zh";
          const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
          if (input) input.value = "pdf2zh";
          const current = this.getSettings().pdf2zhPath;
          const removesActive = current === executable || activeExecutable === executable;
          await this.persist(removesActive);
          this.checkedExecutable = undefined;
          this.probeOk = false;
          root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!.hidden = true;
          root.querySelector<HTMLElement>("[data-pdf2zh-status]")!.textContent = "当前 PDF2ZH 已卸载，可重新安装或接入其他安装。";
          status.textContent = "卸载完成，已有译稿保留。";
          return;
        }
        status.textContent = `正在验证${label}结果…`;
        const after = await inspectUvToolPdf2zh(executable);
        if (!after) throw new Error("操作后无法确认安装路径，请重新检测");
        const probe = await probePdf2zh(after.executable, getNodeRequire()!);
        if (this.disposed || this.deployAbort.signal.aborted) throw new Error(`${label}已取消`);
        if (!probe.ok) throw new Error(`${label}后启动检查失败：${probe.detail}`);
        this.draft.pdf2zhPath = after.executable;
        const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
        if (input) input.value = after.executable;
        await this.persist(); await this.refreshPdf2zh(root);
        status.textContent = action === "upgrade" && before.version === after.version
          ? `已检查升级，当前仍为 ${after.version}。原版本约束内无更新；若锁定版本，需通过原安装方式调整约束。`
          : `${label}完成：${after.version}，启动检查通过。`;
      } catch (error) {
        status.textContent = errorMessage(error); term.append(errorMessage(error)); term.show();
        this.probeOk = false;
        this.toolSelection = undefined;
        root.querySelector<HTMLElement>("[data-pdf2zh-status]")!.textContent = "操作未完成，环境状态需重新检测。";
      } finally {
        release?.();
        this.deployAbort = undefined;
        if (cancel) { cancel.hidden = true; cancel.textContent = "取消安装"; }
      }
    });
  }

  private async scanPython(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
    const select = root.querySelector<HTMLSelectElement>("[data-python-select]")!;
    await this.withDeployBusy(root, async () => {
      try {
        status.hidden = false;
        status.textContent = "正在查找 Python 解释器…";
        const list = await scanPython(undefined, (done, total) => {
          status.textContent = `正在验证解释器 ${done}/${total}…`;
        });
        select.innerHTML = `<option value="">自动（Python 3.12）</option>` + list.map(item => {
          const note = item.support === "supported" ? "" : item.support === "unverified" ? "（未验证）" : "（不支持）";
          const disabled = item.support === "unsupported" ? "disabled" : "";
          return `<option value="${escapeHtml(item.path)}" ${disabled}>Python ${item.version} · ${escapeHtml(item.arch)} · ${escapeHtml(item.path)}${note}</option>`;
        }).join("");
        this.syncPythonControls(root);
        status.textContent = `发现 ${list.length} 个 Python；同一解释器的 python/python3 已合并。${this.draft.pythonPath ? `当前部署 Python：${this.draft.pythonPath}` : "将自动查找或下载 Python 3.12。"}`;
      } catch (error) {
        status.hidden = false;
        status.textContent = `扫描失败：${errorMessage(error)}`;
      }
    });
  }

  private syncPythonControls(root: HTMLElement): void {
    const python = this.draft.pythonPath?.trim() ?? "";
    const select = root.querySelector<HTMLSelectElement>("[data-python-select]");
    if (select) {
      // Keep a custom interpreter visible even when it was not found by the scanner.
      if (typeof document !== "undefined") {
        select.querySelector("[data-custom-python]")?.remove();
        const custom = document.createElement("option");
        custom.value = "__custom__"; custom.dataset.customPython = "true";
        custom.textContent = python ? `自定义：${python}` : "自定义路径";
        // Remove the initial placeholder before appending its current representation.
        for (const option of [...select.options]) if (option.value === "__custom__") option.remove();
        select.append(custom);
      }
      select.value = !python ? "" : [...select.options].some(option => option.value === python && !option.disabled) ? python : "__custom__";
    }
    const manual = root.querySelector<HTMLInputElement>("[data-python-manual]");
    if (manual) manual.value = python;
  }

  private updatePythonChoice(root: HTMLElement, python: string): void {
    this.draft.pythonPath = python.trim();
    this.dirty = true;
    this.pythonChoiceRevision++;
    this.syncPythonControls(root);
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
    status.hidden = false;
    status.textContent = this.draft.pythonPath ? `当前部署 Python：${this.draft.pythonPath}` : "自动模式：查找或下载 Python 3.12。";
  }

  private async selectPython(root: HTMLElement, python: string): Promise<void> {
    this.updatePythonChoice(root, python);
    // Selecting the interpreter for a future install does not change the current environment.
  }

  private async installPdf2zh(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
    const python = this.draft.pythonPath?.trim() ?? "";
    const term = this.deployTerminal(root);
    await this.withDeployBusy(root, async () => {
      status.hidden = false;
      term.clear();
      this.deployAbort = new AbortController();
      const cancel = root.querySelector<HTMLButtonElement>("[data-cancel-install]");
      if (cancel) cancel.hidden = false;
      const options = { ...this.draft, signal: this.deployAbort.signal };
      let release: (() => void) | undefined;
      try {
        release = pdf2zhActivity.acquireMutation();
        validateDownloadSources(options);
        if (this.isTranslationRunning()) throw new Error("有翻译任务正在执行或排队，请完成后再管理 pdf2zh");
        await this.persist();
        if (python) await validateDeploymentPython(python);
        let uv = await findUv(undefined, python);
        if (!uv) {
          status.textContent = "第 1/3 步：正在安装 uv…";
          term.append("安装独立 uv 到插件管理目录…");
          const result = await installUv(options, undefined, line => term.append(line));
          if (result.code !== 0) throw new Error(`uv 安装失败：${result.stderr || "无输出"}`);
          uv = await findUv(undefined, python);
        }
        if (options.signal.aborted || this.disposed) throw new Error("安装已取消");
        if (!uv) throw new Error("uv 安装完成但无法调用；请手动安装 uv 后重试，或填写已有 pdf2zh 的可执行文件路径");
        status.textContent = "第 2/3 步：正在通过 uv 安装 pdf2zh…";
        term.append(`$ ${uv.display} tool install --python ${python || "3.12"} --with ${PDF2ZH_COMPAT_REQUIREMENT} pdf2zh`);
        const result = await installPdf2zh(python, uv, undefined, line => term.append(line), options);
        if (options.signal.aborted) throw new Error("安装已取消，可重新安装以继续完成环境准备");
        if (result.code !== 0) throw new Error(`pdf2zh 安装失败：${result.stderr || "无输出"}`);
        if (cancel) cancel.hidden = true;
        status.textContent = "第 3/3 步：正在验证安装…";
        const executable = await resolvePdf2zh(uv);
        if (!executable) throw new Error("安装完成但未找到 pdf2zh 可执行文件");
        const probe = await probePdf2zh(executable, getNodeRequire()!);
        if (options.signal.aborted || this.disposed) throw new Error("安装已取消");
        if (!probe.ok) throw new Error(`安装后启动检查失败：${probe.detail}`);
        this.draft.pythonPath = python;
        this.syncPythonControls(root);
        this.draft.pdf2zhPath = executable;
        const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
        if (input) input.value = executable;
        status.textContent = `pdf2zh 安装完成：${executable}`;
        await this.persist(true);
        await this.refreshPdf2zh(root);
      } catch (error) {
        term.show();
        term.append(errorMessage(error));
        status.textContent = `${errorMessage(error)}（详见终端输出）`;
      } finally {
        release?.();
        this.deployAbort = undefined;
        if (cancel) cancel.hidden = true;
      }
    });
  }

}

function fieldInfo(label: string, hint = ""): string {
  return `<div class="paper-manager-field-info"><span>${escapeHtml(label)}</span>${hint ? `<small class="paper-manager-hint">${escapeHtml(hint)}</small>` : ""}</div>`;
}
function textField(label: string, key: keyof PluginSettings, value: string, hint = ""): string {
  return `<label class="paper-manager-field">${fieldInfo(label, hint)}<input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
