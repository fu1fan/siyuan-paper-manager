import { DOWNLOAD_PRESETS } from "../services/download-presets";
import { canUseNode, getNodeRequire, requireNode } from "../core/env";
import { Setting, showMessage, confirm } from "siyuan";
import type { KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, pdf2zhLanguageCode, serializeArgs, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";
import { configPath, detectPdf2zh, findUv, installPdf2zh, installUv, inspectPdf2zh, PDF2ZH_COMPAT_REQUIREMENT, systemConfigPath, uninstallPdf2zh, resolvePdf2zh, scanPython, sameExecutable, validateDownloadSources, validateDeploymentPython } from "../services/pdf2zh-deployment";
import { resolveExecutable } from "../services/translator";
import { probePdf2zh } from "../services/environment-check";
import { canonicalSecretEnvKey, pdf2zhCredentialKeys, pdf2zhRequiresSecret, withCredentialPlaceholders } from "../services/pdf2zh-secrets";
import { canonicalPdf2zhConfig, cloneConfig, configModelValue, configTranslatorValue, firstTranslator, maskSecrets, modelEnvKey, restoreMaskedSecrets, secretSafeConfig } from "../services/pdf2zh-config";
import { errorMessage } from "../core/errors";
import { FontPicker, fontPickerHtml } from "./font-picker";

type TabName = "library" | "receiving" | "storage" | "metadata" | "translation";

const TAB_NAMES: Array<[TabName, string]> = [
  ["library", "文献库"], ["receiving", "导入与接收"], ["storage", "论文存储"],
  ["metadata", "PDF 元数据"], ["translation", "翻译"],
];

/** Show one settings tab and mark the others hidden, keeping ARIA state in sync. */
function activateTab(tabs: HTMLElement, panels: Map<TabName, HTMLElement>, name: TabName): void {
  for (const panel of panels.values()) {
    const active = panel.dataset.panel === name;
    panel.dataset.active = String(active);
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  }
  for (const tab of tabs.querySelectorAll<HTMLButtonElement>("button")) {
    const active = tab.dataset.tab === name;
    tab.dataset.active = String(active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

function settingsSection(title: string, description: string, content: string): string {
  return `<div class="paper-manager-settings-section"><div class="paper-manager-section-heading"><h3>${title}</h3>${description ? `<p class="paper-manager-hint">${escapeHtml(description)}</p>` : ""}</div>${content}</div>`;
}

function receivingPanelHtml(draft: PluginSettings): string {
  if (!canUseNode()) return `<div class="paper-manager-preview">当前环境不支持 Zotero Connector 浏览器扩展接收，请使用本地 PDF 导入。接收设置保留供桌面端使用。</div>`;
  return settingsSection("Zotero Connector", "浏览器扩展与本地 PDF 均导入默认文献库。", `
    ${numberField("接收端口", "zoteroPort", draft.zoteroPort, 1024, 65535, "用于接收 Zotero Connector 发送的文献，默认 23119。")}
    ${switchField("启动时自动监听", "autoListen", draft.autoListen, "启动思源时开启接收服务。")}`);
}

function storagePanelHtml(draft: PluginSettings): string {
  return settingsSection("论文文档", "设置新论文的命名规则和默认标签。", `
    ${textField("引用键格式", "citekeyFormat", draft.citekeyFormat, "{title} 标题首段、{year} 年份、{author} 第一作者姓氏。留空恢复默认；保存后用于新导入和手动重新生成。")}
    <details class="paper-manager-settings-help"><summary>引用键格式示例与规则</summary><p class="paper-manager-hint">默认 {title}{year}{author}，例如 flashaccel2026wang；也可使用 {author}_{year}_{title}。标题首段最多 16 字符，中文转无声调拼音，结果全部小写。可添加字母、数字、下划线和连字符。基础引用键最多 64 字符，重名自动加后缀。已有引用键保持不变。</p></details>
    ${textField("默认标签", "defaultDocumentTag", draft.defaultDocumentTag, "填写一个标签名，不含 # 或逗号；留空不添加。保存后同步全部文献库中的论文文档，修改会替换原默认标签，清空会移除原默认标签。其他标签和数据库关键词保留。")}`)
    + settingsSection("附件存储", "", `
    ${textField("附件目录", "assetsDir", draft.assetsDir, "PDF 等论文附件在工作区内的保存目录。")}
    <p class="paper-manager-hint">元数据模板与笔记模板随插件打包，不写入 data/templates。</p>`);
}

function metadataPanelHtml(draft: PluginSettings): string {
  return settingsSection("元数据提取", "提取结果会展示多个候选，导入前可核对并编辑标题、作者与摘要。", `
    ${switchField("自动提取元数据", "autoExtractMetadata", draft.autoExtractMetadata, "选择 PDF 后自动提取并联网补充。关闭后仍可在导入页点击「提取元数据」。")}
    ${switchField("Zotero 在线识别", "enableZoteroRecognizer", draft.enableZoteroRecognizer, "提取时会将 PDF 前五页文本、排版、内嵌元数据及文件名发送至 Zotero 官方识别服务。")}`)
    + settingsSection("中文检索", "实验性功能，需要思源桌面端。", `
    ${switchField("启用知网检索", "enableCnki", draft.enableCnki)}
    ${numberField("单次请求超时", "cnkiTimeoutSeconds", draft.cnkiTimeoutSeconds, 1, 120, "单位：秒，范围 1–120，默认 10。用于搜索、详情和引用补充，不包含手动验证等待；保存后下次检索生效。")}
    <label class="paper-manager-field">${fieldInfo("知网站点")}<select class="b3-select" data-key="cnkiRegion"><option value="mainland" ${draft.cnkiRegion !== "oversea" ? "selected" : ""}>中国大陆</option><option value="oversea" ${draft.cnkiRegion === "oversea" ? "selected" : ""}>海外</option></select></label>
    <p class="paper-manager-hint">首次检索或会话过期时会打开知网窗口；请完成验证后返回继续，同一会话会自动复用。超时包含连接及完整响应接收时间。</p>`);
}

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;
  private initialTab: TabName = "library";
  private configSaveTimer?: ReturnType<typeof setTimeout>;
  private configRoot?: HTMLElement;
  private configRevision = 0;
  private savedConfigRevision = 0;
  private confirming = false;
  private deployBusy = false;
  private deployAbort?: AbortController;
  private pythonChoiceRevision = 0;
  private managedSelection = false;
  private fontPicker?: FontPicker;

  private updateManagementControls(root: HTMLElement): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-upgrade-pdf2zh], [data-repair-pdf2zh], [data-uninstall-pdf2zh]")) button.disabled = this.deployBusy || !this.managedSelection;
  }

  /** 部署操作（扫描/安装/升级/卸载）互斥：进行中禁用相关按钮，防止并发写同一 uv 环境。 */
  private async withDeployBusy(root: HTMLElement, work: () => Promise<void>): Promise<void> {
    if (this.deployBusy) return;
    this.deployBusy = true;
    const buttons = root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      "[data-scan-pdf2zh], [data-uninstall-pdf2zh], [data-upgrade-pdf2zh], [data-repair-pdf2zh], [data-install-pdf2zh], [data-scan-python], [data-python-select], [data-python-manual], [data-key=pdf2zhPath], [data-download-sources] input, [data-download-sources] select, [data-download-sources] button",
    );
    for (const button of buttons) button.disabled = true;
    try {
      await work();
    } finally {
      this.deployBusy = false;
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

  constructor(
    private readonly displayName: string,
    private readonly getSettings: () => PluginSettings,
    private readonly kernel: KernelClient,
    private readonly libraries: LibraryService,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
    private readonly getSecret?: (name: string) => string,
    private readonly isTranslationRunning: () => boolean = () => false,
    private readonly openIntroduction?: () => void,
    private readonly openSecretsSettings?: () => void,
  ) {
    this.draft = structuredClone(getSettings());
    this.setting = new Setting({
      width: "min(860px, calc(100vw - 32px))",
      height: "min(720px, calc(100dvh - 64px))",
      confirmCallback: () => { this.confirming = true; this.cancelConfigTimer(); void this.save(); },
      // A debounced config write must not fire after the dialog's editor is gone.
      destroyCallback: () => {
        this.cancelConfigTimer();
        this.fontPicker?.destroy();
        this.fontPicker = undefined;
        if (!this.confirming) this.configRevision++;
      },
    });
    this.setting.addItem({ title: "", direction: "column", createActionElement: () => this.build() });
  }

  open(tab: TabName = "library"): void {
    if (this.configRoot?.isConnected) {
      this.configRoot.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.click();
      return;
    }
    this.initialTab = tab;
    this.setting.open(this.displayName);
  }

  private build(): HTMLElement {
    this.fontPicker?.destroy();
    this.fontPicker = undefined;
    this.confirming = false;
    this.savedConfigRevision = ++this.configRevision;
    this.draft = structuredClone(this.getSettings());
    this.pythonChoiceRevision = 0;
    this.managedSelection = false;
    const root = document.createElement("div");
    this.configRoot = root;
    root.className = "paper-manager-form paper-manager-settings";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "论文管理设置");
    const body = document.createElement("div");
    body.className = "paper-manager-settings-body";
    const panels = new Map<TabName, HTMLElement>();
    const activate = (name: TabName) => {
      activateTab(tabs, panels, name);
      body.scrollTop = 0;
    };
    for (const [name, label] of TAB_NAMES) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "paper-manager-tab";
      tab.textContent = label;
      tab.dataset.tab = name;
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); activate(name); });
      tabs.append(tab);
      const panel = document.createElement("section");
      panel.className = "paper-manager-panel";
      panel.dataset.panel = name;
      panel.setAttribute("role", "tabpanel");
      panels.set(name, panel);
      body.append(panel);
    }
    root.append(tabs, body);
    let replayButton: HTMLButtonElement | undefined;
    if (this.openIntroduction) {
      replayButton = document.createElement("button");
      replayButton.type = "button";
      replayButton.className = "b3-button b3-button--text paper-manager-settings-replay";
      replayButton.dataset.replayIntroduction = "";
      replayButton.textContent = "重新播放欢迎页面";
      replayButton.title = "查看功能介绍与 PDF2ZH 配置指南";
      replayButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openIntroduction?.();
      });
    }
    this.renderPanels(panels);
    this.bindEvents(root);
    this.bindConfigTabs(root);
    this.renderConfigVisual(root);
    const fontRoot = root.querySelector<HTMLElement>("[data-font-picker]");
    if (fontRoot) this.fontPicker = new FontPicker(fontRoot);
    if (canUseNode()) void this.scanPdf2zh(root);
    activate(this.initialTab);
    this.initialTab = "library";
    void this.renderLibraries(root);
    // Bazaar opens setting directly, bypassing open(). The SDK attaches this
    // custom control synchronously after build(), so normalize its wrappers
    // after mounting for both entry points. Only the inner body should scroll.
    queueMicrotask(() => {
      if (!root.isConnected) return;
      root.closest(".config-item")?.classList.add("paper-manager-settings-host");
      const dialog = root.closest(".b3-dialog__container");
      dialog?.classList.add("paper-manager-settings-dialog");
      // Share the native action row, leaving all available height to the settings body.
      if (replayButton) dialog?.querySelector(".b3-dialog__action")?.prepend(replayButton);
    });
    return root;
  }

  private renderPanels(panels: Map<TabName, HTMLElement>): void {
    panels.get("library")!.innerHTML = `<div data-library-content>正在读取文献库…</div>`;
    panels.get("receiving")!.innerHTML = receivingPanelHtml(this.draft);
    panels.get("storage")!.innerHTML = storagePanelHtml(this.draft);
    panels.get("metadata")!.innerHTML = metadataPanelHtml(this.draft);
    panels.get("translation")!.innerHTML = this.translationPanelHtml();
  }

  /** Wire the panels' controls; the markup is produced by `renderPanels`. */
  private bindEvents(root: HTMLElement): void {
    root.addEventListener("input", (event) => this.capture(event));
    root.addEventListener("change", (event) => this.capture(event));
    root.addEventListener("input", (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches("[data-secret-name]")) return;
      this.setSecretName(input.dataset.secretName!, input.value);
      this.scheduleSaveConfig(root);
    });
    root.querySelector<HTMLSelectElement>("[data-config-key=translator]")?.addEventListener("change", () => this.syncVisualToJson(root));
    root.querySelector<HTMLButtonElement>("[data-scan-python]")?.addEventListener("click", () => void this.scanPython(root));
    root.querySelector<HTMLButtonElement>("[data-scan-pdf2zh]")?.addEventListener("click", () => void this.scanPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-uninstall-pdf2zh]")?.addEventListener("click", () => void this.uninstallPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-upgrade-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root, true));
    root.querySelector<HTMLButtonElement>("[data-install-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-cancel-install]")?.addEventListener("click", () => this.deployAbort?.abort());
    root.querySelector<HTMLButtonElement>("[data-repair-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root, false, true));
    root.querySelector<HTMLButtonElement>("[data-apply-download-preset]")?.addEventListener("click", () => {
      const id = root.querySelector<HTMLSelectElement>("[data-download-preset]")?.value;
      const preset = DOWNLOAD_PRESETS.find(item => item.id === id);
      if (!preset) return;
      Object.assign(this.draft, preset.values);
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
    root.querySelector<HTMLButtonElement>("[data-test-secrets]")?.addEventListener("click", () => {
      const result = this.testSecrets(root);
      showMessage(result.message, 4000, result.error ? "error" : undefined);
    });
    root.querySelector<HTMLButtonElement>("[data-open-secrets-settings]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openSecretsSettings?.();
    });
    root.querySelector<HTMLButtonElement>("[data-load-config]")?.addEventListener("click", () => void this.loadConfig(root));
    root.querySelector<HTMLButtonElement>("[data-import-system-config]")?.addEventListener("click", () => void this.importSystemConfig(root));
  }

  /** The translation tab depends on the panel's stored secret name, so it stays a method. */
  private translationPanelHtml(): string {
    if (!canUseNode()) return `<div class="paper-manager-preview">当前环境不支持 pdf2zh 翻译。可阅读桌面端翻译后同步的 PDF；翻译设置保留供桌面端使用。</div><div class="paper-manager-actions">${this.secretsSettingsButtonHtml()}</div>`;
    const config = this.draft.pdf2zhConfig ?? {};
    const service = configTranslatorValue(config);
    return settingsSection("插件翻译设置", "选择翻译语言，调整任务并发和输出文件。", `
      ${languageSelect("源语言", "translateFrom", pdf2zhLanguageCode(this.draft.translateFrom), true, "data-key")}
      ${languageSelect("目标语言", "translateTo", pdf2zhLanguageCode(this.draft.translateTo), false, "data-key")}
      ${numberField("每篇请求并发数", "translationThreads", this.draft.translationThreads, 1, 128, "范围 1–128，默认 4；对应 pdf2zh 的 --thread（-t）。")}
      ${numberField("同时翻译篇数", "translationConcurrency", this.draft.translationConcurrency, 1, 8, "范围 1–8；总请求并发最多约为两项设置的乘积，下次提交时生效。取消会停止全部任务。")}
      ${switchField("保留双语版", "translationDual", this.draft.translationDual, "同时保留原文与译文的双语 PDF。")}
      ${switchField("删除旧翻译版本", "autoDeleteOldTranslations", this.draft.autoDeleteOldTranslations, "仅在新翻译及元数据保存成功后删除；删除失败不会影响新版本。")}`)
      + settingsSection('pdf2zh 部署 <span class="paper-manager-badge paper-manager-badge--testing">测试中</span>', "扫描已有安装，或自动准备环境并安装。", `
      <div class="paper-manager-actions"><button type="button" class="b3-button b3-button--outline" data-scan-pdf2zh>扫描 pdf2zh</button><button type="button" class="b3-button b3-button--text" data-upgrade-pdf2zh disabled>升级</button><button type="button" class="b3-button b3-button--text" data-repair-pdf2zh disabled>修复安装</button><button type="button" class="b3-button b3-button--text" data-uninstall-pdf2zh disabled>卸载</button></div>
      <div class="paper-manager-preview" data-pdf2zh-status>尚未扫描</div>
      <div data-pdf2zh-existing hidden><div class="paper-manager-preview" data-pdf2zh-detail></div></div>
      <div data-pdf2zh-deploy>
        <p class="paper-manager-hint">默认自动查找 Python 3.12，缺少时下载；无需预装 Python。升级和卸载仅管理此环境；已有安装可填写下方路径继续使用。安装完成后请保存设置。</p>
        <details><summary>高级：指定 Python</summary>
        <label class="paper-manager-field">${fieldInfo("部署 Python")}<div class="paper-manager-python-choice"><select class="b3-select" data-python-select aria-label="部署 Python"><option value="">自动（Python 3.12）</option></select><button type="button" class="b3-button b3-button--outline" data-scan-python>扫描</button></div></label>
        <label class="paper-manager-field">${fieldInfo("手动 Python 路径")}<input class="b3-text-field" data-python-manual value="${escapeHtml(this.draft.pythonPath)}" placeholder="留空自动选择，或填写 /path/to/python"></label>
        </details>
        <details data-download-sources><summary>自定义下载源</summary>
          <p class="paper-manager-hint">留空沿用 uv 默认或已有环境配置。包索引不影响 Python 和 uv 下载；以下地址分别设置。安装时立即使用当前填写值，保存设置后供下次使用。</p>
          <div class="paper-manager-actions"><select class="b3-select" data-download-preset aria-label="下载源预设"><option value="">选择镜像预设…</option>${DOWNLOAD_PRESETS.map(item => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join("")}</select><button type="button" class="b3-button b3-button--outline" data-apply-download-preset>填入预设</button></div>
          <p class="paper-manager-hint" data-download-preset-status role="status">清华和北外仅替换包索引；中科大替换全部下载源。中科大仅镜像最新发布，缺失的 Python 文件会转回 GitHub。</p>
          ${textField("Python 包索引", "pdf2zhIndexUrl", this.draft.pdf2zhIndexUrl ?? "", "PEP 503 索引，例如 https://pypi.org/simple")}
          ${textField("Python 下载镜像", "pdf2zhPythonMirror", this.draft.pdf2zhPythonMirror ?? "", "替换 https://github.com/astral-sh/python-build-standalone/releases/download 的根地址；须保留日期与文件名目录结构。")}
          ${textField("uv 安装脚本目录", "pdf2zhUvInstallerUrl", this.draft.pdf2zhUvInstallerUrl ?? "", "默认 https://astral.sh/uv；自定义目录须提供 install.sh 和 install.ps1。中科大预设已适配 uv-installer 脚本。")}
          ${textField("uv 发布文件目录", "pdf2zhUvDownloadUrl", this.draft.pdf2zhUvDownloadUrl ?? "", "可直接提供对应版本的 uv 压缩包目录；优先于下方 GitHub 镜像。中科大预设会自动填入。")}
          ${textField("uv GitHub 镜像", "pdf2zhUvGithubUrl", this.draft.pdf2zhUvGithubUrl ?? "", "替换 https://github.com 的根地址；镜像须提供 astral-sh/uv 发布文件。仅缺少 uv 时使用。")}
        </details>
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-install-pdf2zh>安装并使用独立环境</button><button type="button" class="b3-button b3-button--outline" data-cancel-install hidden>取消安装</button></div>
      </div>
      ${textField("pdf2zh 路径", "pdf2zhPath", this.draft.pdf2zhPath, "可执行文件路径；已安装在 PATH 中时可填写 pdf2zh。")}
      <div class="paper-manager-preview" data-deploy-status hidden></div><details class="paper-manager-term" data-term hidden><summary>终端输出</summary><pre data-term-log></pre></details>`)
      + settingsSection("pdf2zh 配置文件", "选择翻译服务、模型，并映射所需密钥。", `
      <div class="paper-manager-actions"><button type="button" class="b3-button b3-button--outline" data-load-config>读取托管配置</button><button type="button" class="b3-button b3-button--text" data-import-system-config>读取系统配置并覆盖</button></div>
      <div class="paper-manager-tabs paper-manager-config-tabs"><button type="button" data-config-tab="visual" data-active="true">可视化</button><button type="button" data-config-tab="json">JSON</button></div>
      <section data-config-panel="visual">
        ${translatorSelect(config)}
        <label class="paper-manager-field">${fieldInfo("模型名称", "仅用于大模型翻译服务。")}<input class="b3-text-field" data-config-key="model" value="${escapeHtml(configModelValue(config))}" placeholder="如 deepseek-chat" ${serviceSupportsModel(service) ? "" : "disabled"}></label>
        <div class="paper-manager-field">${fieldInfo("翻译字体", "选择本机字体；留空由 pdf2zh 自动选择。")}${fontPickerHtml()}</div>
      </section>
      <section data-config-panel="json" hidden><textarea class="b3-text-field" rows="9" data-config-json placeholder="{}" aria-label="pdf2zh JSON 配置"></textarea></section>
      <div data-secret-fields>${this.secretFieldsHtml(service)}</div>
      <div class="paper-manager-actions"><button type="button" class="b3-button b3-button--outline" data-test-secrets ${serviceRequiresKey(service) ? "" : "disabled"}>测试密钥</button>${this.secretsSettingsButtonHtml()}</div>
      <p class="paper-manager-hint">可视化和 JSON 编辑同一份配置；未知字段保留在 JSON 中。请为每个环境变量填写对应的思源密钥名称，密钥值不会写入 JSON。</p>`)
      + settingsSection("高级选项", "", `
      ${textField("翻译资源目录", "translationAssetsDir", this.draft.translationAssetsDir)}
      ${textareaField("额外 CLI 参数", "pdf2zhArgs", serializeArgs(this.draft.pdf2zhArgs), "传给 pdf2zh 的额外命令行参数。")}
      <details class="paper-manager-settings-help"><summary>语言与配置文件的关系</summary><p class="paper-manager-hint">语言通过 <code>-li</code>/<code>-lo</code> 命令行参数传给 pdf2zh。命令行忽略配置文件里的语言键，因此语言属于插件设置；字体路径 NOTO_FONT_PATH 仍在配置文件中编辑。服务所需密钥通过思源「密钥和变量」映射，或使用环境变量。</p></details>`);
  }

  private async scanPdf2zh(root: HTMLElement): Promise<void> {
    await this.withDeployBusy(root, () => this.refreshPdf2zh(root));
  }

  private async refreshPdf2zh(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!;
    const choiceRevision = this.pythonChoiceRevision;
    const configured = this.draft.pdf2zhPath;
    this.managedSelection = false;
    try {
      const installed = await inspectPdf2zh(undefined, this.draft.pythonPath || undefined);
      const explicit = configured.trim() && configured.trim() !== "pdf2zh";
      const executable = explicit ? await resolveExecutable(configured, getNodeRequire()!)
        : installed?.executable ?? await detectPdf2zh();
      if ((this.configRoot && root !== this.configRoot) || choiceRevision !== this.pythonChoiceRevision || configured !== this.draft.pdf2zhPath) return;
      const existing = root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!;
      existing.hidden = !executable;
      // Keep Python selection available for upgrades and installing alongside an external tool.
      root.querySelector<HTMLElement>("[data-pdf2zh-deploy]")!.hidden = false;
      if (!executable) {
        status.textContent = "未找到 pdf2zh，可直接安装独立环境。";
        return;
      }
      this.managedSelection = Boolean(installed && sameExecutable(executable, installed.executable));
      const term = this.deployTerminal(root);
      const probe = await probePdf2zh(executable, getNodeRequire()!, 15_000, {
        autoRepair: !this.isTranslationRunning(),
        onLine: line => { term.show(); term.append(line); status.textContent = line; },
      });
      if ((this.configRoot && root !== this.configRoot) || choiceRevision !== this.pythonChoiceRevision || configured !== this.draft.pdf2zhPath) return;
      if (!probe.ok) throw new Error(probe.detail);
      this.managedSelection = Boolean(installed && sameExecutable(executable, installed.executable));
      if (!explicit) {
        this.draft.pdf2zhPath = executable;
        const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
        if (input) input.value = executable;
      }
      status.textContent = (probe.detail.includes("已自动修复") ? "腾讯云 SDK 依赖已自动修复。" : "") + (this.managedSelection ? "插件独立环境：启动检查通过，可升级或卸载。"
        : "已有安装：启动检查通过。请通过原安装方式升级或卸载，或安装插件独立环境。");
      root.querySelector<HTMLElement>("[data-pdf2zh-detail]")!.textContent =
        `${this.managedSelection && installed?.version ? `版本 ${installed.version} · ` : ""}${executable}`;
      if (this.configRevision === this.savedConfigRevision) await this.loadConfig(root);
    } catch (error) {
      status.textContent = `检查失败：${errorMessage(error)}${this.managedSelection ? "；可尝试修复安装。" : ""}`;
    } finally {
      this.updateManagementControls(root);
    }
  }

  private async requireManagedSelection(): Promise<void> {
    if (this.isTranslationRunning()) throw new Error("有翻译任务正在执行或排队，请完成后再管理 pdf2zh");
    const installed = await inspectPdf2zh(undefined, this.draft.pythonPath || undefined);
    const executable = await resolveExecutable(this.draft.pdf2zhPath, getNodeRequire()!);
    if (!installed || !sameExecutable(executable, installed.executable)) throw new Error("当前使用已有安装，请通过原安装方式升级或卸载");
  }

  private async uninstallPdf2zh(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!;
    const term = this.deployTerminal(root);
    await this.withDeployBusy(root, async () => {
      try {
        await this.requireManagedSelection();
        term.clear();
        term.show();
        status.textContent = "正在卸载插件独立环境中的 pdf2zh…";
        const result = await uninstallPdf2zh(undefined, this.draft.pythonPath || undefined, line => term.append(line));
        status.textContent = result.code === 0 ? "pdf2zh 已卸载。" : `卸载失败：${result.stderr || "未知错误"}`;
        if (result.code === 0) {
          this.draft.pdf2zhPath = "pdf2zh";
          const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
          if (input) input.value = "pdf2zh";
          await this.refreshPdf2zh(root);
        }
      } catch (error) {
        status.textContent = `卸载失败：${errorMessage(error)}`;
      }
    });
  }

  private bindConfigTabs(root: HTMLElement): void {
    for (const tab of root.querySelectorAll<HTMLButtonElement>("[data-config-tab]")) tab.addEventListener("click", () => {
      const name = tab.dataset.configTab;
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-config-tab]")) button.dataset.active = String(button === tab);
      for (const panel of root.querySelectorAll<HTMLElement>("[data-config-panel]")) panel.hidden = panel.dataset.configPanel !== name;
      if (name === "json") this.syncVisualToJson(root);
    });
    root.querySelectorAll<HTMLElement>("[data-config-key]").forEach(input => { const sync = () => { this.syncVisualToJson(root); this.scheduleSaveConfig(root); }; input.addEventListener("input", sync); input.addEventListener("change", sync); });
    root.querySelector<HTMLTextAreaElement>("[data-config-json]")?.addEventListener("input", () => { this.syncJsonToVisual(root); this.scheduleSaveConfig(root); });
  }

  /** JSON 文本域是可视化的数据源：先落到草稿配置再回填，避免空文本域被当成 {} 清掉草稿。 */
  private renderConfigVisual(root: HTMLElement): void {
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]");
    if (area && !area.value.trim()) area.value = JSON.stringify(maskSecrets(cloneConfig(this.draft.pdf2zhConfig)), null, 2);
    this.syncJsonToVisual(root);
  }

  /** Serialize the visual controls into one canonical pdf2zh translator entry. */
  private syncVisualToJson(root: HTMLElement): void {
    const config = cloneConfig(this.draft.pdf2zhConfig);
    const values = new Map<string, string>();
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-config-key]")) values.set(input.dataset.configKey!, input.value);
    const fontPath = values.get("NOTO_FONT_PATH");
    if (fontPath != null) {
      if (fontPath) config["NOTO_FONT_PATH"] = fontPath;
      else delete config["NOTO_FONT_PATH"];
    }
    const service = values.get("translator")?.trim() || configTranslatorValue(config);
    const model = values.get("model")?.trim() || "";
    const previous = firstTranslator(config);
    const envs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(previous?.envs && typeof previous.envs === "object" ? previous.envs as Record<string, unknown> : {})) {
      if (/_MODEL$/i.test(key)) continue;
      envs[canonicalSecretEnvKey(key)] = value;
    }
    if (serviceSupportsModel(service) && model) envs[modelEnvKey(service)] = model;
    const entry: Record<string, unknown> = { ...(previous ?? {}), name: service, envs: withCredentialPlaceholders(envs, service) };
    config.translators = [entry];
    delete config.translator;
    this.draft.pdf2zhConfig = config;
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]");
    if (area) area.value = JSON.stringify(maskSecrets(config), null, 2);
    this.refreshTranslatorControls(root, service);
  }

  private syncJsonToVisual(root: HTMLElement): void {
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]"); if (!area) return;
    try {
      const parsed = JSON.parse(area.value || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const config = canonicalPdf2zhConfig(restoreMaskedSecrets(parsed, this.draft.pdf2zhConfig) as Record<string, unknown>);
      this.draft.pdf2zhConfig = config;
      const service = configTranslatorValue(config);
      for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-config-key]")) {
        const key = input.dataset.configKey!;
        const raw = key === "translator" ? service : key === "model" ? configModelValue(config) : config[key];
        input.value = raw == null ? "" : String(raw);
      }
      this.refreshTranslatorControls(root, service);
      this.fontPicker?.update();
    } catch { /* leave invalid JSON visible for save validation */ }
  }

  private refreshTranslatorControls(root: HTMLElement, service: string): void {
    const fields = root.querySelector<HTMLElement>("[data-secret-fields]");
    if (fields) fields.innerHTML = this.secretFieldsHtml(service);
    const model = root.querySelector<HTMLInputElement>("[data-config-key=model]");
    if (model) model.disabled = !serviceSupportsModel(service);
    const test = root.querySelector<HTMLButtonElement>("[data-test-secrets]");
    if (test) test.disabled = !serviceRequiresKey(service);
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
        select.onchange = () => void this.selectPython(root, select.value);
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
    if (select) select.value = [...select.options].some(option => option.value === python && !option.disabled) ? python : "";
    const manual = root.querySelector<HTMLInputElement>("[data-python-manual]");
    if (manual) manual.value = python;
  }

  private updatePythonChoice(root: HTMLElement, python: string): void {
    this.draft.pythonPath = python.trim();
    this.pythonChoiceRevision++;
    this.syncPythonControls(root);
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
    status.hidden = false;
    status.textContent = this.draft.pythonPath ? `当前部署 Python：${this.draft.pythonPath}` : "自动模式：查找或下载 Python 3.12。";
  }

  private async selectPython(root: HTMLElement, python: string): Promise<void> {
    this.updatePythonChoice(root, python);
    if (this.draft.pythonPath) await this.scanPdf2zh(root);
  }

  private async installPdf2zh(root: HTMLElement, upgrade = false, repair = false): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!;
    const python = this.draft.pythonPath?.trim() ?? "";
    const term = this.deployTerminal(root);
    await this.withDeployBusy(root, async () => {
      status.hidden = false;
      term.clear();
      this.deployAbort = new AbortController();
      const cancel = root.querySelector<HTMLButtonElement>("[data-cancel-install]");
      if (cancel) cancel.hidden = false;
      const options = { ...this.draft, upgrade, repair, signal: this.deployAbort.signal };
      try {
        validateDownloadSources(options);
        if (this.isTranslationRunning()) throw new Error("有翻译任务正在执行或排队，请完成后再管理 pdf2zh");
        if (upgrade || repair) await this.requireManagedSelection();
        if (python) await validateDeploymentPython(python);
        let uv = await findUv(undefined, python);
        if (!uv) {
          term.show();
          status.textContent = "第 1/3 步：正在安装 uv…";
          term.append("安装独立 uv 到插件管理目录…");
          const result = await installUv(options, undefined, line => term.append(line));
          if (result.code !== 0) throw new Error(`uv 安装失败：${result.stderr || "无输出"}`);
          uv = await findUv(undefined, python);
        }
        if (!uv) throw new Error("uv 安装完成但无法调用；请手动安装 uv 后重试，或填写已有 pdf2zh 的可执行文件路径");
        term.show();
        status.textContent = repair ? "第 2/3 步：正在修复 pdf2zh…" : upgrade ? "第 2/3 步：正在升级 pdf2zh…" : "第 2/3 步：正在通过 uv 安装 pdf2zh…";
        term.append(`$ ${uv.display} tool install ${upgrade ? "--upgrade " : repair ? "--reinstall " : ""}--python ${python || "3.12"} --with ${PDF2ZH_COMPAT_REQUIREMENT} pdf2zh`);
        const result = await installPdf2zh(python, uv, undefined, line => term.append(line), options);
        if (options.signal.aborted) throw new Error("安装已取消，可重新安装以继续完成环境准备");
        if (result.code !== 0) throw new Error(`pdf2zh 安装失败：${result.stderr || "无输出"}`);
        if (cancel) cancel.hidden = true;
        status.textContent = "第 3/3 步：正在验证安装…";
        const executable = await resolvePdf2zh(uv);
        if (!executable) throw new Error("安装完成但未找到 pdf2zh 可执行文件");
        const probe = await probePdf2zh(executable, getNodeRequire()!);
        if (!probe.ok) throw new Error(`安装后启动检查失败：${probe.detail}`);
        this.draft.pythonPath = python;
        this.syncPythonControls(root);
        this.draft.pdf2zhPath = executable;
        const input = root.querySelector<HTMLInputElement>("[data-key=pdf2zhPath]");
        if (input) input.value = executable;
        status.textContent = `pdf2zh ${repair ? "修复" : upgrade ? "升级" : "安装"}完成：${executable}`;
        await this.refreshPdf2zh(root);
      } catch (error) {
        term.show();
        term.append(errorMessage(error));
        status.textContent = `${errorMessage(error)}（详见终端输出）`;
      } finally {
        this.deployAbort = undefined;
        if (cancel) cancel.hidden = true;
      }
    });
  }

  private async loadConfig(root: HTMLElement): Promise<void> {
    const revision = this.configRevision;
    try {
      const fs = requireNode<typeof import("node:fs")>("fs");
      const path = requireNode<typeof import("node:path")>("path");
      const workspace = await this.kernel.getWorkspaceInfo();
      if (revision !== this.configRevision || (this.configRoot && root !== this.configRoot)) return;
      const target = configPath(workspace.workspaceDir);
      this.draft.pdf2zhConfigPath = target;
      const exists = fs.existsSync(target);
      const parsed = canonicalPdf2zhConfig(exists ? JSON.parse(fs.readFileSync(target, "utf8")) : (this.draft.pdf2zhConfig ?? {}));
      // 旧版托管配置缺少凭据键名占位，会让 pdf2zh 直接抛 KeyError；读取时顺手修复并回写。
      const repaired = secretSafeConfig(parsed);
      this.draft.pdf2zhConfig = repaired;
      if (!exists || JSON.stringify(parsed) !== JSON.stringify(repaired)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
      }
      root.querySelector<HTMLTextAreaElement>("[data-config-json]")!.value = JSON.stringify(maskSecrets(repaired), null, 2);
      this.syncJsonToVisual(root);
    } catch (error) { showMessage(`读取配置失败：${errorMessage(error)}`, 5000, "error"); }
  }

  private async importSystemConfig(root: HTMLElement): Promise<void> {
    confirm("读取系统配置将直接覆盖当前托管配置，是否继续？", "", () => { void this.performSystemImport(root); });
  }

  private async performSystemImport(root: HTMLElement): Promise<void> {
    try {
      const fs = requireNode<typeof import("node:fs")>("fs"); const source = systemConfigPath();
      if (!fs.existsSync(source)) throw new Error(`未找到系统配置：${source}`);
      const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("系统配置不是 JSON 对象");
      this.cancelConfigTimer();
      const revision = ++this.configRevision;
      const workspace = await this.kernel.getWorkspaceInfo(); const target = configPath(workspace.workspaceDir);
      if (revision !== this.configRevision) return;
      const path = requireNode<typeof import("node:path")>("path"); fs.mkdirSync(path.dirname(target), { recursive: true });
      const safeConfig = secretSafeConfig(canonicalPdf2zhConfig(parsed));
      fs.writeFileSync(target, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
      this.savedConfigRevision = revision;
      this.draft.pdf2zhConfigPath = target; this.draft.pdf2zhConfig = safeConfig;
      await this.loadConfig(root); showMessage("系统配置已导入托管配置", 3000);
    } catch (error) { showMessage(`导入系统配置失败：${errorMessage(error)}`, 5000, "error"); }
  }

  private cancelConfigTimer(): void {
    if (this.configSaveTimer) clearTimeout(this.configSaveTimer);
    this.configSaveTimer = undefined;
  }

  private scheduleSaveConfig(root: HTMLElement): void {
    const revision = ++this.configRevision;
    this.cancelConfigTimer();
    this.configSaveTimer = setTimeout(() => {
      this.configSaveTimer = undefined;
      void this.saveConfig(root, revision).catch((error) => {
        if (revision === this.configRevision) showMessage(`保存配置失败：${errorMessage(error)}`, 5000, "error");
      });
    }, 500);
  }

  private async saveConfig(root: HTMLElement, revision: number): Promise<void> {
    const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]")!;
    if (root.querySelector<HTMLButtonElement>("[data-config-tab='visual']")?.dataset.active === "true") this.syncVisualToJson(root);
    const parsedRaw = JSON.parse(area.value || "{}");
    if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) throw new Error("配置必须是 JSON 对象");
    const parsed = canonicalPdf2zhConfig(restoreMaskedSecrets(parsedRaw, this.draft.pdf2zhConfig) as Record<string, unknown>);
    const fs = requireNode<typeof import("node:fs")>("fs");
    const path = requireNode<typeof import("node:path")>("path");
    const workspace = await this.kernel.getWorkspaceInfo();
    // Older workspace lookups must never overwrite a newer edit or a closed dialog.
    if (revision !== this.configRevision) return;
    const target = configPath(workspace.workspaceDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const safeConfig = secretSafeConfig(parsed);
    fs.writeFileSync(target, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
    this.savedConfigRevision = revision;
    this.draft.pdf2zhConfigPath = target;
    this.draft.pdf2zhConfig = safeConfig;
    area.value = JSON.stringify(maskSecrets(safeConfig), null, 2);
    this.syncJsonToVisual(root);
  }

  private secretFieldsHtml(service: string): string {
    const keys = pdf2zhCredentialKeys(service);
    if (!keys.length) return `<div class="paper-manager-preview">此服务无需密钥。</div>`;
    return keys.map(key => `<label class="paper-manager-field">${fieldInfo(key, "填写思源「密钥和变量」中的名称。")}<input class="b3-text-field" data-secret-name="${escapeHtml(key)}" value="${escapeHtml(this.draft.pdf2zhSecretNames?.[key] ?? "")}" placeholder="填写思源「密钥和变量」中的名称"></label>`).join("");
  }

  private secretsSettingsButtonHtml(): string {
    return this.openSecretsSettings ? `<button type="button" class="b3-button b3-button--text" data-open-secrets-settings>打开密钥和变量设置 ↗</button>` : "";
  }

  private setSecretName(key: string, name: string): void {
    this.draft.pdf2zhSecretNames = { ...(this.draft.pdf2zhSecretNames ?? {}), [key]: name.trim() };
  }

  private testSecrets(root: HTMLElement): { message: string; error: boolean } {
    const keys = pdf2zhCredentialKeys(configTranslatorValue(this.draft.pdf2zhConfig ?? {}));
    const names = new Map([...root.querySelectorAll<HTMLInputElement>("[data-secret-name]")]
      .map(input => [input.dataset.secretName!, input.value.trim()]));
    const unmapped = keys.filter(key => !names.get(key));
    if (unmapped.length) return { message: `请先填写映射：${unmapped.join("、")}`, error: true };
    const missing = keys.filter(key => !this.getSecret?.(names.get(key)!));
    if (missing.length) return { message: `缺少密钥：${missing.map(key => names.get(key)).join("、")}`, error: true };
    return { message: `已找到 ${keys.length} 个密钥`, error: false };
  }

  private capture(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const key = input.dataset.key as keyof PluginSettings | undefined;
    if (!key) return;
    let value: unknown = input instanceof HTMLInputElement && input.type === "checkbox"
      ? input.checked
      : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (key === "pdf2zhArgs") value = splitArgString(String(value));
    (this.draft as unknown as Record<string, unknown>)[key] = value;
    if (key === "pdf2zhPath" && this.configRoot) {
      this.managedSelection = false;
      this.updateManagementControls(this.configRoot);
    }
  }

  private async renderLibraries(root: HTMLElement): Promise<void> {
    const container = root.querySelector<HTMLElement>("[data-library-content]")!;
    try {
      const libraries = await this.libraries.discoverLibraries();
      if (!this.draft.defaultLibraryDocId && libraries[0]) this.draft.defaultLibraryDocId = libraries[0].docId;
      container.innerHTML = `${settingsSection("默认文献库", "选择论文的导入目标，或创建新的文献库。", `${libraries.length ? librarySelector(libraries, this.draft.defaultLibraryDocId) : "<div class=\"paper-manager-preview\">尚未创建文献库。</div>"}
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-create-library>新建文献库</button></div>
        `)}<div data-library-editor></div>`;
      container.querySelector<HTMLSelectElement>("[data-default-library]")?.addEventListener("change", (event) => {
        this.draft.defaultLibraryDocId = (event.target as HTMLSelectElement).value;
        void this.renderLibraryEditor(container, libraries);
      });
      container.querySelector<HTMLButtonElement>("[data-create-library]")!.addEventListener("click", () => {
        void openOnboardingDialog(this.kernel, this.libraries, async (library) => {
          this.draft.defaultLibraryDocId = library.docId;
          this.draft.onboardingCompleted = true;
          await this.onSave(normalizeSettings(this.draft));
          await this.renderLibraries(root);
        }, "新建论文文献库");
      });
      await this.renderLibraryEditor(container, libraries);
    } catch (error) {
      container.innerHTML = `<div class="paper-manager-preview">读取失败：${escapeHtml(errorMessage(error))}</div>`;
    }
  }

  private async renderLibraryEditor(container: HTMLElement, libraries: PaperLibraryInfo[]): Promise<void> {
    const editor = container.querySelector<HTMLElement>("[data-library-editor]");
    if (!editor) return;
    const selected = libraries.find((library) => library.docId === this.draft.defaultLibraryDocId) ?? libraries[0];
    if (!selected) { editor.innerHTML = ""; return; }
    editor.innerHTML = settingsSection(escapeHtml(selected.title), "文献库维护", `
      <div class="paper-manager-preview">${escapeHtml(selected.hPath)} · 数据库 ${escapeHtml(selected.data.avId)}</div>
      <div class="paper-manager-preview">请直接在数据库「所属项目」中填写或选择项目，可多选；列的显示与排序也在数据库视图中操作。</div>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>重新同步</button>
        <button type="button" class="b3-button b3-button--text" data-repair>修复数据库</button>
      </div>`);
    editor.querySelector<HTMLButtonElement>("[data-sync]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.syncLibrary(selected.docId);
      return `同步完成：${result.papers} 篇，恢复 ${result.restoredRows} 行，移除 ${result.removedRows} 行，失败 ${result.failed.length} 篇`;
    });
    editor.querySelector<HTMLButtonElement>("[data-repair]")!.onclick = () => void actionMessage(async () => {
      const result = await this.libraries.repairLibrary(selected.docId);
      return `修复完成：同步 ${result.papers} 篇论文`;
    });
  }

  private async save(): Promise<void> {
    try {
      if (this.configRevision > this.savedConfigRevision && this.configRoot?.querySelector("[data-config-json]")) {
        await this.saveConfig(this.configRoot, ++this.configRevision);
      }
      validateDownloadSources(this.draft);
      const settings = normalizeSettings(this.draft);
      settings.onboardingCompleted = Boolean(settings.defaultLibraryDocId);
      await this.onSave(settings);
      this.draft = structuredClone(settings);
    } catch (error) {
      showMessage(`设置保存失败：${errorMessage(error)}`, 5000, "error");
      return;
    }
    showMessage("论文管理设置已保存", 5000, "info");
  }
}

function fieldInfo(label: string, hint = ""): string {
  return `<div class="paper-manager-field-info"><span>${escapeHtml(label)}</span>${hint ? `<small class="paper-manager-hint">${escapeHtml(hint)}</small>` : ""}</div>`;
}
function textField(label: string, key: keyof PluginSettings, value: string, hint = ""): string {
  return `<label class="paper-manager-field">${fieldInfo(label, hint)}<input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
function numberField(label: string, key: keyof PluginSettings, value: number, min = 1024, max = 65535, hint = ""): string {
  return `<label class="paper-manager-field paper-manager-field--number">${fieldInfo(label, hint)}<input class="b3-text-field" type="number" min="${min}" max="${max}" step="1" data-key="${key}" value="${value}"></label>`;
}
function switchField(label: string, key: keyof PluginSettings, value: boolean, hint = ""): string {
  return `<label class="paper-manager-field paper-manager-field--switch">${fieldInfo(label, hint)}<input class="b3-switch" type="checkbox" data-key="${key}" ${value ? "checked" : ""}></label>`;
}
function textareaField(label: string, key: keyof PluginSettings, value: string, hint = ""): string {
  return `<label class="paper-manager-field paper-manager-field--column">${fieldInfo(label, hint)}<textarea class="b3-text-field" rows="4" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
}
const PDF2ZH_LANGUAGES: Array<[string, string]> = [
  ["auto", "自动检测"], ["en", "英语"], ["zh", "中文"], ["ja", "日语"], ["ko", "韩语"],
  ["de", "德语"], ["fr", "法语"], ["es", "西班牙语"], ["it", "意大利语"], ["pt", "葡萄牙语"],
  ["ru", "俄语"], ["ar", "阿拉伯语"], ["nl", "荷兰语"], ["pl", "波兰语"], ["uk", "乌克兰语"],
  ["tr", "土耳其语"], ["vi", "越南语"], ["th", "泰语"], ["id", "印度尼西亚语"], ["hi", "印地语"],
  ["he", "希伯来语"], ["cs", "捷克语"], ["da", "丹麦语"], ["fi", "芬兰语"], ["el", "希腊语"],
  ["hu", "匈牙利语"], ["no", "挪威语"], ["ro", "罗马尼亚语"], ["sk", "斯洛伐克语"], ["sv", "瑞典语"],
];
/** 语言下拉。`attribute` 决定它写回托管配置还是插件设置。 */
function languageSelect(label: string, key: string, value = "", allowAuto = false, attribute: "data-config-key" | "data-key" = "data-config-key"): string {
  const languages = allowAuto ? PDF2ZH_LANGUAGES : PDF2ZH_LANGUAGES.filter(([code]) => code !== "auto");
  const options = languages.some(([code]) => code === value) || !value
    ? languages
    : [[value, `${value}（自定义）`] as [string, string], ...languages];
  return `<label class="paper-manager-field">${fieldInfo(label)}<select class="b3-select" ${attribute}="${key}">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)} (${escapeHtml(code)})</option>`).join("")}</select></label>`;
}
const PDF2ZH_SERVICES: Array<[string, string]> = [
  ["google", "Google"], ["bing", "Bing"], ["deepl", "DeepL"], ["deeplx", "DeepLX"], ["openai", "OpenAI"],
  ["ollama", "Ollama"], ["xinference", "Xinference"], ["azure-openai", "Azure OpenAI"], ["zhipu", "智谱"],
  ["modelscope", "ModelScope"], ["silicon", "SiliconCloud"], ["gemini", "Gemini"], ["azure", "Azure"],
  ["tencent", "腾讯"], ["dify", "Dify"], ["anythingllm", "AnythingLLM"], ["argos", "Argos Translate"],
  ["grok", "Grok"], ["groq", "Groq"], ["deepseek", "DeepSeek"], ["openailiked", "OpenAI 兼容"], ["qwen-mt", "阿里通义翻译"],
];
/** 无密钥服务（Google/Bing/Ollama/Xinference/Argos）之外的都需要凭据。 */
function serviceRequiresKey(service: string): boolean { return pdf2zhRequiresSecret(service); }
const MODEL_SERVICES = new Set(["openai", "ollama", "xinference", "azure-openai", "zhipu", "modelscope", "silicon", "gemini", "grok", "groq", "deepseek", "openailiked", "qwen-mt"]);
function serviceSupportsModel(service: string): boolean { return MODEL_SERVICES.has(service); }
function translatorSelect(config: Record<string, unknown>): string {
  const value = configTranslatorValue(config); const options = PDF2ZH_SERVICES.some(([code]) => code === value) ? PDF2ZH_SERVICES : [[value, `${value}（自定义）`] as [string, string], ...PDF2ZH_SERVICES];
  return `<label class="paper-manager-field">${fieldInfo("默认服务")}<select class="b3-select" data-config-key="translator">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
}
function librarySelector(libraries: PaperLibraryInfo[], selected: string): string {
  return `<label class="paper-manager-field">${fieldInfo("默认文献库", "Connector 与本地 PDF 的默认导入目标。")}<select class="b3-select" data-default-library>${libraries.map((library) =>
    `<option value="${escapeHtml(library.docId)}" ${library.docId === selected ? "selected" : ""}>${escapeHtml(library.title)}</option>`).join("")}</select></label>`;
}

async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`文献库操作失败：${errorMessage(error)}`, 7000, "error"); }
}
