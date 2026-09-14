import { canUseNode, requireNode } from "../core/env";
import { Setting, showMessage, confirm } from "siyuan";
import type { KernelClient } from "../core/kernel";
import type { LibraryService, PaperLibraryInfo } from "../services/library-service";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings, pdf2zhLanguageCode, serializeArgs, splitArgString } from "../types/settings";
import { escapeHtml } from "./dom";
import { openOnboardingDialog } from "./dialogs/onboarding";
import { configPath, detectPdf2zh, findUv, installPdf2zh, installUv, inspectPdf2zh, systemConfigPath, uninstallPdf2zh, resolvePdf2zh, scanPython } from "../services/pdf2zh-deployment";
import { canonicalSecretEnvKey, pdf2zhPrimarySecretKey, pdf2zhRequiresSecret, withCredentialPlaceholders } from "../services/pdf2zh-secrets";
import { canonicalPdf2zhConfig, cloneConfig, configModelValue, configTranslatorValue, firstTranslator, maskSecrets, modelEnvKey, restoreMaskedSecrets, secretSafeConfig } from "../services/pdf2zh-config";
import { errorMessage } from "../core/errors";

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

function receivingPanelHtml(draft: PluginSettings): string {
  if (!canUseNode()) return `<div class="paper-manager-preview">当前环境不支持 Zotero Connector 浏览器扩展接收，请使用本地 PDF 导入。接收设置保留供桌面端使用。</div>`;
  return `
      ${numberField("Zotero 端口", "zoteroPort", draft.zoteroPort)}
      ${switchField("启动时自动监听", "autoListen", draft.autoListen)}
      <div class="paper-manager-preview">Connector 与本地 PDF 始终导入默认文献库。</div>`;
}

function storagePanelHtml(draft: PluginSettings): string {
  return `
      ${textField("引用键生成格式", "citekeyFormat", draft.citekeyFormat)}
      <p class="paper-manager-hint">占位符：{title} 标题首段（最多 16 字符），{year} 年份，{author} 第一作者姓氏。中文转无声调拼音，结果全部小写。可添加字母、数字、下划线和连字符。</p>
      <p class="paper-manager-hint">默认：{title}{year}{author}，例如 flashaccel2026wang。可改为 {author}_{year}_{title}。基础引用键最多 64 字符，重名自动加后缀。保存后用于新导入和手动重新生成，已有引用键保持不变；留空恢复默认。</p>
      ${textField("论文文档默认标签（留空不添加）", "defaultDocumentTag", draft.defaultDocumentTag)}
      <p class="paper-manager-hint">填写一个标签名，不含 # 或逗号。保存后同步全部文献库中的论文文档，新建论文也会自动添加。修改会替换原默认标签，清空会删除原默认标签；其他文档标签保留，不修改数据库关键词。</p>
      ${textField("附件目录", "assetsDir", draft.assetsDir)}
      <div class="paper-manager-preview">元数据模板与笔记模板随插件打包，不写入 data/templates。</div>`;
}

function metadataPanelHtml(draft: PluginSettings): string {
  return `
      ${switchField("自动提取元数据", "autoExtractMetadata", draft.autoExtractMetadata)}
      <p class="paper-manager-hint">选择 PDF 后自动提取并联网补充。关闭后仍可在导入页点击「提取元数据」。</p>
      ${switchField("使用 Zotero 在线识别", "enableZoteroRecognizer", draft.enableZoteroRecognizer)}
      <p class="paper-manager-hint">开启后，提取时会将 PDF 前五页文本、排版、内嵌元数据及文件名发送至 Zotero 官方识别服务。</p>
      ${switchField("中文检索（实验性）", "enableCnki", draft.enableCnki)}
      ${numberField("知网单次请求超时（秒，1–120）", "cnkiTimeoutSeconds", draft.cnkiTimeoutSeconds, 1, 120)}
      <div class="paper-manager-preview">默认 10 秒。分别用于搜索、详情和引用补充的单次网络请求，包含连接及完整响应接收时间；不包含手动验证等待。保存后下次检索生效。</div>
      <label class="paper-manager-field"><span>知网站点</span><select class="b3-select" data-key="cnkiRegion"><option value="mainland" ${draft.cnkiRegion !== "oversea" ? "selected" : ""}>中国大陆</option><option value="oversea" ${draft.cnkiRegion === "oversea" ? "selected" : ""}>海外</option></select></label>
      <div class="paper-manager-preview">知网检索需要思源桌面端。首次检索或会话过期时会打开知网窗口；请完成验证后返回继续，同一会话会自动复用。</div>
      <div class="paper-manager-preview">提取结果会展示多个候选，导入前可核对并编辑标题、作者与摘要。</div>`;
}

export class SettingsPanel {
  readonly setting: Setting;
  private draft: PluginSettings;
  private configSaveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly displayName: string,
    private readonly getSettings: () => PluginSettings,
    private readonly kernel: KernelClient,
    private readonly libraries: LibraryService,
    private readonly onSave: (settings: PluginSettings) => Promise<void>,
    private readonly getSecret?: (name: string) => string,
  ) {
    this.draft = structuredClone(getSettings());
    this.setting = new Setting({
      width: "820px",
      height: "680px",
      confirmCallback: () => { void this.save(); },
      // A debounced config write must not fire after the dialog's editor is gone.
      destroyCallback: () => { if (this.configSaveTimer) clearTimeout(this.configSaveTimer); this.configSaveTimer = undefined; },
    });
    this.setting.addItem({ title: "", direction: "column", createActionElement: () => this.build() });
  }

  open(): void { this.setting.open(this.displayName); }

  private build(): HTMLElement {
    this.draft = structuredClone(this.getSettings());
    const root = document.createElement("div");
    root.className = "paper-manager-form paper-manager-settings";
    const tabs = document.createElement("div");
    tabs.className = "paper-manager-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "论文管理设置");
    const panels = new Map<TabName, HTMLElement>();
    const activate = (name: TabName) => activateTab(tabs, panels, name);
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
      root.append(panel);
    }
    root.prepend(tabs);
    this.renderPanels(panels);
    this.bindEvents(root);
    this.bindConfigTabs(root);
    this.renderConfigVisual(root);
    void this.scanPdf2zh(root);
    activate("library");
    void this.renderLibraries(root);
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
    root.querySelector<HTMLInputElement>("[data-secret-name]")?.addEventListener("input", (event) => { this.setSecretName(String((event.target as HTMLInputElement).value), configTranslatorValue(this.draft.pdf2zhConfig ?? {})); this.scheduleSaveConfig(root); });
    root.querySelector<HTMLSelectElement>("[data-config-key=translator]")?.addEventListener("change", (event) => { const service = String((event.target as HTMLSelectElement).value).trim(); this.syncVisualToJson(root); this.setSecretNameForService(service, root); this.refreshTranslatorControls(root, service); });
    root.querySelector<HTMLButtonElement>("[data-scan-python]")?.addEventListener("click", () => void this.scanPython(root));
    root.querySelector<HTMLButtonElement>("[data-scan-pdf2zh]")?.addEventListener("click", () => void this.scanPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-uninstall-pdf2zh]")?.addEventListener("click", () => void this.uninstallPdf2zh(root));
    root.querySelector<HTMLButtonElement>("[data-upgrade-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root, true));
    root.querySelector<HTMLButtonElement>("[data-install-pdf2zh]")?.addEventListener("click", () => void this.installPdf2zh(root));
    root.querySelector<HTMLInputElement>("[data-python-manual]")?.addEventListener("change", () => void this.selectPython(root, root.querySelector<HTMLInputElement>("[data-python-manual]")!.value));
    root.querySelector<HTMLButtonElement>("[data-test-secrets]")?.addEventListener("click", () => { try { const value = ({ [this.secretEnvKey(configTranslatorValue(this.draft.pdf2zhConfig ?? {}))]: root.querySelector<HTMLInputElement>("[data-secret-name]")?.value.trim() || "" }); const entries = Object.entries(value).filter(([, name]) => typeof name === "string" && name.trim()); if (!entries.length) throw new Error("请先填写映射"); const missing = entries.filter(([, name]) => !this.getSecret?.(String(name))); showMessage(missing.length ? `缺少密钥：${missing.map(([, name]) => name).join("、")}` : `已找到 ${entries.length} 个密钥`, 4000, missing.length ? "error" : undefined); } catch (error) { showMessage(`密钥映射格式错误：${errorMessage(error)}`, 4000, "error"); } });
    root.querySelector<HTMLButtonElement>("[data-load-config]")?.addEventListener("click", () => void this.loadConfig(root));
    root.querySelector<HTMLButtonElement>("[data-import-system-config]")?.addEventListener("click", () => void this.importSystemConfig(root));
  }

  /** The translation tab depends on the panel's stored secret name, so it stays a method. */
  private translationPanelHtml(): string {
    if (!canUseNode()) return `<div class="paper-manager-preview">当前环境不支持 pdf2zh 翻译。可阅读桌面端翻译后同步的 PDF；翻译设置保留供桌面端使用。</div>`;
    const config = this.draft.pdf2zhConfig ?? {};
    const service = configTranslatorValue(config);
    return `
      <h3>pdf2zh 部署 <span class="paper-manager-badge paper-manager-badge--testing">测试中</span></h3><div class="paper-manager-actions"><button type="button" class="b3-button" data-scan-pdf2zh>扫描 pdf2zh</button><button type="button" class="b3-button" data-uninstall-pdf2zh>卸载</button><button type="button" class="b3-button" data-upgrade-pdf2zh>升级</button></div><div class="paper-manager-preview" data-pdf2zh-status data-deploy-status>尚未扫描</div><div data-pdf2zh-existing hidden><div class="paper-manager-preview" data-pdf2zh-detail></div></div><div data-pdf2zh-deploy><div class="paper-manager-preview">一键部署（自动查找 Python 并安装 pdf2zh）仍在测试中，在部分系统环境可能失败。若自动部署不可用，可自行安装后在上方「pdf2zh 路径」中填写可执行文件路径，再点「扫描 pdf2zh」。</div><div class="paper-manager-actions"><button type="button" class="b3-button" data-scan-python>扫描 Python</button><select class="b3-select" data-python-select><option value="">选择用于部署的 Python</option></select></div><label class="paper-manager-field"><span>手动选择 Python 路径</span><input class="b3-text-field" data-python-manual placeholder="/path/to/python"></label><button type="button" class="b3-button" data-install-pdf2zh>安装 pdf2zh</button></div>
      <h3>pdf2zh 配置文件</h3>
      <div class="paper-manager-actions"><button type="button" class="b3-button" data-load-config>读取托管配置</button><button type="button" class="b3-button" data-import-system-config>读取系统配置并覆盖</button></div>
      <div class="paper-manager-tabs paper-manager-config-tabs"><button type="button" data-config-tab="visual" data-active="true">可视化</button><button type="button" data-config-tab="json">JSON</button></div>
      <section data-config-panel="visual">${languageSelect("源语言", "PDF2ZH_LANG_FROM", pdf2zhLanguageCode(String(config.PDF2ZH_LANG_FROM ?? this.draft.translateFrom)), true)}${languageSelect("目标语言", "PDF2ZH_LANG_TO", pdf2zhLanguageCode(String(config.PDF2ZH_LANG_TO ?? this.draft.translateTo)), false)}<label class="paper-manager-field"><span>字体路径</span><input class="b3-text-field" data-config-key="NOTO_FONT_PATH"></label>${translatorSelect(config)}<label class="paper-manager-field"><span>模型名称（大模型服务）</span><input class="b3-text-field" data-config-key="model" value="${escapeHtml(configModelValue(config))}" placeholder="如 deepseek-chat" ${serviceSupportsModel(service) ? "" : "disabled"}></label></section>
      <section data-config-panel="json" hidden><textarea class="b3-text-field" rows="9" data-config-json placeholder="{}"></textarea></section>
      <div class="paper-manager-inline-field"><label class="paper-manager-field"><span>服务密钥名称</span><input class="b3-text-field" data-secret-name value="${escapeHtml(this.secretNameForService(service))}" placeholder="填写思源「密钥和变量」中的名称" ${serviceRequiresKey(service) ? "" : "disabled"}></label><button type="button" class="b3-button" data-test-secrets>测试密钥</button></div>
      <div class="paper-manager-preview">可视化和 JSON 编辑的是同一个 pdf2zh 配置对象；未知字段只在 JSON 标签页中保留。只填写一个思源「密钥和变量」中的密钥名称；环境变量名会根据上方翻译服务自动生成。密钥值不会写入 JSON。</div>
      <div class="paper-manager-preview">源/目标语言由插件以 -li/-lo 传给 pdf2zh。pdf2zh 自身只在图形界面读取配置中的语言键，命令行（含直接用 pdf2zh 命令翻译）需要显式传 -li/-lo，否则它会回退到默认的 en→zh。字体路径（NOTO_FONT_PATH）则会被命令行读取。</div>
      <h3>插件翻译设置</h3>
      ${textField("pdf2zh 路径", "pdf2zhPath", this.draft.pdf2zhPath)}
      ${numberField("请求并发数（每篇 PDF，1–128）", "translationThreads", this.draft.translationThreads, 1, 128)}
      ${numberField("同时翻译篇数（1–8）", "translationConcurrency", this.draft.translationConcurrency, 1, 8)}
      ${switchField("保留双语版", "translationDual", this.draft.translationDual)}
      ${switchField("重新翻译后删除旧版本", "autoDeleteOldTranslations", this.draft.autoDeleteOldTranslations)}
      ${textareaField("额外 CLI 参数", "pdf2zhArgs", serializeArgs(this.draft.pdf2zhArgs))}
      ${textField("翻译资源目录", "translationAssetsDir", this.draft.translationAssetsDir)}
      <div class="paper-manager-preview">请求并发数对应 pdf2zh 的 --thread（-t），默认 4；同时翻译多篇时，总请求并发最多约为两项设置的乘积。服务所需密钥请在 pdf2zh 配置文件或环境变量中设置。并行篇数下次提交时生效，取消会停止全部任务。自动删除仅在新翻译及元数据保存成功后执行；删除失败不会影响新版本。</div>`;
  }

  private async scanPdf2zh(root: HTMLElement): Promise<void> { const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; try { const installed = await inspectPdf2zh(); const existing = root.querySelector<HTMLElement>("[data-pdf2zh-existing]")!; const deploy = root.querySelector<HTMLElement>("[data-pdf2zh-deploy]")!; if (installed) { this.draft.pdf2zhPath = installed.executable; if (installed.pythonPath) this.draft.pythonPath = installed.pythonPath; status.textContent = "已找到可用的 pdf2zh，已自动关联其 Python。"; root.querySelector<HTMLElement>("[data-pdf2zh-detail]")!.textContent = `${installed.version ? `版本 ${installed.version} · ` : ""}${installed.executable}${installed.pythonPath ? ` · Python ${installed.pythonPath}` : ""}`; existing.hidden = false; deploy.hidden = true; await this.loadConfig(root); } else { status.textContent = "未找到可用的 pdf2zh，请选择 Python 后部署。"; existing.hidden = true; deploy.hidden = false; } } catch (error) { status.textContent = `扫描失败：${errorMessage(error)}`; } }

  private async uninstallPdf2zh(root: HTMLElement): Promise<void> { const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; try { const result = await uninstallPdf2zh(); status.textContent = result.code === 0 ? "pdf2zh 已卸载。" : `卸载失败：${result.stderr}`; if (result.code === 0) { this.draft.pdf2zhPath = "pdf2zh"; await this.scanPdf2zh(root); } } catch (error) { status.textContent = `卸载失败：${errorMessage(error)}`; } }

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
    for (const key of ["PDF2ZH_LANG_FROM", "PDF2ZH_LANG_TO", "NOTO_FONT_PATH"] as const) {
      const value = values.get(key);
      if (value != null && value !== "") config[key] = value;
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
        // 语言键缺失时回退到插件翻译设置，避免面板把有效语言悄悄改掉。
        const raw = key === "translator" ? service : key === "model" ? configModelValue(config)
          : key === "PDF2ZH_LANG_FROM" ? config[key] ?? this.draft.translateFrom
            : key === "PDF2ZH_LANG_TO" ? config[key] ?? this.draft.translateTo : config[key];
        input.value = raw == null ? "" : (key === "PDF2ZH_LANG_FROM" || key === "PDF2ZH_LANG_TO") ? pdf2zhLanguageCode(String(raw)) : String(raw);
      }
      const secret = root.querySelector<HTMLInputElement>("[data-secret-name]");
      if (secret) secret.value = this.secretNameForService(service);
      this.refreshTranslatorControls(root, service);
    } catch { /* leave invalid JSON visible for save validation */ }
  }

  private refreshTranslatorControls(root: HTMLElement, service: string): void {
    const secret = root.querySelector<HTMLInputElement>("[data-secret-name]");
    if (secret) secret.disabled = !serviceRequiresKey(service);
    const model = root.querySelector<HTMLInputElement>("[data-config-key=model]");
    if (model) model.disabled = !serviceSupportsModel(service);
    const test = root.querySelector<HTMLButtonElement>("[data-test-secrets]");
    if (test) test.disabled = !serviceRequiresKey(service);
  }

  private async scanPython(root: HTMLElement): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-deploy-status]")!; const select = root.querySelector<HTMLSelectElement>("[data-python-select]")!;
    try { const list = await scanPython(); select.innerHTML = list.map(item => `<option value="${escapeHtml(item.path)}" ${item.path === this.draft.pythonPath ? "selected" : ""} ${item.supported ? "" : "disabled"}>Python ${item.version} · ${escapeHtml(item.arch)} · ${escapeHtml(item.path)}${item.supported ? "" : "（不支持）"}</option>`).join(""); select.onchange = () => void this.selectPython(root, select.value); status.textContent = `发现 ${list.length} 个 Python；同一解释器的 python/python3 已合并。`; } catch (error) { status.textContent = `扫描失败：${errorMessage(error)}`; }
  }

  private async selectPython(root: HTMLElement, python: string): Promise<void> { const status = root.querySelector<HTMLElement>("[data-deploy-status]")!; const value = python.trim(); if (!value) return; this.draft.pythonPath = value; status.textContent = "正在检测 pdf2zh 安装和配置…"; try { const executable = await detectPdf2zh(); if (executable) this.draft.pdf2zhPath = executable; await this.loadConfig(root); status.textContent = executable ? `已找到 pdf2zh：${executable}，配置已读取。` : "未找到 pdf2zh；配置已读取。"; } catch (error) { status.textContent = `检测失败：${errorMessage(error)}`; } }

  private async installPdf2zh(root: HTMLElement, upgrade = false): Promise<void> {
    const status = root.querySelector<HTMLElement>("[data-pdf2zh-status]")!; const python = root.querySelector<HTMLSelectElement>("[data-python-select]")?.value || root.querySelector<HTMLInputElement>("[data-python-manual]")?.value || this.draft.pythonPath;
    if (!python) { status.textContent = "请先扫描并选择 Python 3.11–3.13。"; return; }
    try { let uv = await findUv(); if (!uv) { status.textContent = "正在安装 uv…"; const result = await installUv(python); if (result.code !== 0) throw new Error(result.stderr || "uv 安装失败"); uv = await findUv(); } if (!uv) throw new Error("安装后仍未找到 uv，请重启思源后重试"); status.textContent = upgrade ? "正在升级 pdf2zh…" : "正在通过 uv 安装 pdf2zh…"; const result = await installPdf2zh(python, uv); if (result.code !== 0) throw new Error(result.stderr || "pdf2zh 安装失败"); const executable = await resolvePdf2zh(uv); if (!executable) throw new Error("安装完成但未找到 pdf2zh 可执行文件"); this.draft.pythonPath = python; this.draft.pdf2zhPath = executable; status.textContent = `pdf2zh ${upgrade ? "升级" : "安装"}完成：${executable}`; await this.scanPdf2zh(root); } catch (error) { status.textContent = `安装失败：${errorMessage(error)}`; }
  }

  private async loadConfig(root: HTMLElement): Promise<void> {
    try {
      const fs = requireNode<typeof import("node:fs")>("fs");
      const path = requireNode<typeof import("node:path")>("path");
      const workspace = await this.kernel.getWorkspaceInfo();
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
      const workspace = await this.kernel.getWorkspaceInfo(); const target = configPath(workspace.workspaceDir);
      const path = requireNode<typeof import("node:path")>("path"); fs.mkdirSync(path.dirname(target), { recursive: true });
      const safeConfig = secretSafeConfig(canonicalPdf2zhConfig(parsed));
      fs.writeFileSync(target, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
      this.draft.pdf2zhConfigPath = target; this.draft.pdf2zhConfig = safeConfig;
      await this.loadConfig(root); showMessage("系统配置已导入托管配置", 3000);
    } catch (error) { showMessage(`导入系统配置失败：${errorMessage(error)}`, 5000, "error"); }
  }

  private scheduleSaveConfig(root: HTMLElement): void { if (this.configSaveTimer) clearTimeout(this.configSaveTimer); this.configSaveTimer = setTimeout(() => { this.configSaveTimer = undefined; void this.saveConfig(root); }, 500); }

  private async saveConfig(root: HTMLElement): Promise<void> { try { const area = root.querySelector<HTMLTextAreaElement>("[data-config-json]")!; if (root.querySelector<HTMLButtonElement>("[data-config-tab='visual']")?.dataset.active === "true") this.syncVisualToJson(root); const parsedRaw = JSON.parse(area.value || "{}"); if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) throw new Error("配置必须是 JSON 对象"); const parsed = canonicalPdf2zhConfig(restoreMaskedSecrets(parsedRaw, this.draft.pdf2zhConfig) as Record<string, unknown>); const fs = requireNode<typeof import("node:fs")>("fs"); const path = requireNode<typeof import("node:path")>("path"); const workspace = await this.kernel.getWorkspaceInfo(); const target = configPath(workspace.workspaceDir); fs.mkdirSync(path.dirname(target), { recursive: true }); const safeConfig = secretSafeConfig(parsed); fs.writeFileSync(target, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8"); this.draft.pdf2zhConfigPath = target; this.draft.pdf2zhConfig = safeConfig; area.value = JSON.stringify(maskSecrets(safeConfig), null, 2); this.syncJsonToVisual(root); } catch (error) { showMessage(`保存配置失败：${errorMessage(error)}`, 5000, "error"); } }

  private secretEnvKey(service: string): string { return pdf2zhPrimarySecretKey(service) || `${service.trim().toUpperCase()}_API_KEY`; }
  private secretNameForService(service: string): string { return this.draft.pdf2zhSecretNames?.[this.secretEnvKey(service)] ?? ""; }
  private setSecretName(name: string, service = configTranslatorValue(this.draft.pdf2zhConfig ?? {})): void { const key = this.secretEnvKey(service); if (!serviceRequiresKey(service)) { const next = { ...(this.draft.pdf2zhSecretNames ?? {}) }; delete next[key]; this.draft.pdf2zhSecretNames = next; return; } this.draft.pdf2zhSecretNames = { ...(this.draft.pdf2zhSecretNames ?? {}), [key]: name.trim() }; }
  private setSecretNameForService(service: string, root?: HTMLElement): void { const input = (root ?? document).querySelector<HTMLInputElement>("[data-secret-name]"); if (input) input.value = this.secretNameForService(service); }

  private capture(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const key = input.dataset.key as keyof PluginSettings | undefined;
    if (!key) return;
    let value: unknown = input instanceof HTMLInputElement && input.type === "checkbox"
      ? input.checked
      : input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
    if (key === "pdf2zhArgs") value = splitArgString(String(value));
    (this.draft as unknown as Record<string, unknown>)[key] = value;
  }

  private async renderLibraries(root: HTMLElement): Promise<void> {
    const container = root.querySelector<HTMLElement>("[data-library-content]")!;
    try {
      const libraries = await this.libraries.discoverLibraries();
      if (!this.draft.defaultLibraryDocId && libraries[0]) this.draft.defaultLibraryDocId = libraries[0].docId;
      container.innerHTML = `${libraries.length ? librarySelector(libraries, this.draft.defaultLibraryDocId) : "<div class=\"paper-manager-preview\">尚未创建文献库。</div>"}
        <div class="paper-manager-actions"><button type="button" class="b3-button" data-create-library>新建文献库</button></div>
        <div data-library-editor></div>`;
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
    editor.innerHTML = `<hr class="b3-hr"><h3>${escapeHtml(selected.title)}</h3>
      <div class="paper-manager-preview">${escapeHtml(selected.hPath)} · 数据库 ${escapeHtml(selected.data.avId)}</div>
      <div class="paper-manager-preview">请直接在数据库「所属项目」中填写或选择项目，可多选；列的显示与排序也在数据库视图中操作。</div>
      <div class="paper-manager-actions">
        <button type="button" class="b3-button b3-button--text" data-sync>重新同步</button>
        <button type="button" class="b3-button b3-button--text" data-repair>修复数据库</button>
      </div>`;
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

function textField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
function numberField(label: string, key: keyof PluginSettings, value: number, min = 1024, max = 65535): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><input class="b3-text-field" type="number" min="${min}" max="${max}" step="1" data-key="${key}" value="${value}"></label>`;
}
function switchField(label: string, key: keyof PluginSettings, value: boolean): string {
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><span><input class="b3-switch" type="checkbox" data-key="${key}" ${value ? "checked" : ""}></span></label>`;
}
function textareaField(label: string, key: keyof PluginSettings, value: string): string {
  return `<label class="paper-manager-field paper-manager-field--column"><span>${escapeHtml(label)}</span><textarea class="b3-text-field" rows="4" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
}
const PDF2ZH_LANGUAGES: Array<[string, string]> = [
  ["auto", "自动检测"], ["en", "英语"], ["zh", "中文"], ["ja", "日语"], ["ko", "韩语"],
  ["de", "德语"], ["fr", "法语"], ["es", "西班牙语"], ["it", "意大利语"], ["pt", "葡萄牙语"],
  ["ru", "俄语"], ["ar", "阿拉伯语"], ["nl", "荷兰语"], ["pl", "波兰语"], ["uk", "乌克兰语"],
  ["tr", "土耳其语"], ["vi", "越南语"], ["th", "泰语"], ["id", "印度尼西亚语"], ["hi", "印地语"],
  ["he", "希伯来语"], ["cs", "捷克语"], ["da", "丹麦语"], ["fi", "芬兰语"], ["el", "希腊语"],
  ["hu", "匈牙利语"], ["no", "挪威语"], ["ro", "罗马尼亚语"], ["sk", "斯洛伐克语"], ["sv", "瑞典语"],
];
function languageSelect(label: string, key: string, value = "", allowAuto = false): string {
  const languages = allowAuto ? PDF2ZH_LANGUAGES : PDF2ZH_LANGUAGES.filter(([code]) => code !== "auto");
  const options = languages.some(([code]) => code === value) || !value
    ? languages
    : [[value, `${value}（自定义）`] as [string, string], ...languages];
  return `<label class="paper-manager-field"><span>${escapeHtml(label)}</span><select class="b3-select" data-config-key="${key}">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)} (${escapeHtml(code)})</option>`).join("")}</select></label>`;
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
  return `<label class="paper-manager-field"><span>默认服务</span><select class="b3-select" data-config-key="translator">${options.map(([code, name]) => `<option value="${escapeHtml(code)}" ${code === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
}
function librarySelector(libraries: PaperLibraryInfo[], selected: string): string {
  return `<label class="paper-manager-field"><span>默认文献库</span><select class="b3-select" data-default-library>${libraries.map((library) =>
    `<option value="${escapeHtml(library.docId)}" ${library.docId === selected ? "selected" : ""}>${escapeHtml(library.title)}</option>`).join("")}</select></label>`;
}

async function actionMessage(action: () => Promise<string>): Promise<void> {
  try { showMessage(await action(), 5000, "info"); }
  catch (error) { showMessage(`文献库操作失败：${errorMessage(error)}`, 7000, "error"); }
}
