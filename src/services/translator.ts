import { translationSource } from "./attachments";
import type { ChildProcess } from "node:child_process";
import type { PaperData } from "../types/paper";
import { extractThreadArgs, normalizeTranslationThreads, pdf2zhLanguageCode, type PluginSettings } from "../types/settings";
import type { TranslationState } from "../types/status";
import { getNodeRequire, type NodeRequire, requireNode } from "../core/env";
import { KernelClient } from "../core/kernel";
import { sanitizeDocumentName } from "../core/naming";
import { resolveShellEnvironment } from "./pdf2zh-deployment";
import { canonicalSecretEnvKey, ensureCredentialPlaceholders, isSecretKey } from "./pdf2zh-secrets";
import { errorMessage } from "../core/errors";

export interface TranslationResult {
  mono?: string;
  dual?: string;
  elapsedMs: number;
  deletedOldAssets: string[];
  cleanupWarnings: string[];
}

export interface TranslatorOptions {
  requireFn?: NodeRequire;
  /** Override process launch for cross-platform integration tests. */
  spawnProcess?: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => ChildProcess;
  onState?: (state: TranslationState) => void;
  /** 从数据库行重建论文数据（数据库权威）。 */
  readPaper: (docId: string) => Promise<PaperData>;
  withPaperLock?: <T>(work: () => Promise<T>) => Promise<T>;
  persist: (docId: string, paper: PaperData) => Promise<void>;
  getSecret?: (name: string) => string;
}

interface QueuedTranslation {
  docId: string;
  settings: PluginSettings;
  untranslatedOnly?: boolean;
  resolve: (result: TranslationResult) => void;
  reject: (error: Error) => void;
}

export class TranslatorService {
  private readonly requireFn: NodeRequire;
  private readonly active = new Map<string, { controller: AbortController; child?: ChildProcess; state: Extract<TranslationState, { state: "running" }> }>();
  private readonly queue: QueuedTranslation[] = [];
  private concurrency = 1;
  private total = 0;
  private succeeded = 0;
  private failed = 0;
  private cancelled = 0;
  private errors: string[] = [];

  constructor(private readonly kernel: KernelClient, private readonly options: TranslatorOptions) {
    const requireFn = options.requireFn ?? getNodeRequire();
    if (!requireFn) throw new Error("Node 子进程不可用，仅支持思源桌面端");
    this.requireFn = requireFn;
  }

  isRunning(): boolean {
    return this.active.size > 0 || this.queue.length > 0;
  }

  taskState(docId: string): "running" | "queued" | undefined {
    if (this.active.has(docId)) return "running";
    if (this.queue.some(task => task.docId === docId)) return "queued";
    return undefined;
  }

  /** 多篇论文按设置的并行上限执行，状态栏显示当前进度与队列长度。 */
  translate(docId: string, settings: PluginSettings, options: { untranslatedOnly?: boolean } = {}): Promise<TranslationResult> {
    if (this.active.has(docId) || this.queue.some((task) => task.docId === docId)) {
      return Promise.reject(new Error("该论文已在翻译队列中"));
    }
    return new Promise<TranslationResult>((resolve, reject) => {
      const snapshot = structuredClone(settings);
      if (!this.isRunning()) {
        this.total = this.succeeded = this.failed = this.cancelled = 0;
        this.errors = [];
      }
      this.queue.push({ docId, settings: snapshot, untranslatedOnly: options.untranslatedOnly, resolve, reject });
      this.total++;
      this.concurrency = Math.max(1, Math.min(8, Math.floor(settings.translationConcurrency || 1)));
      this.pump();
      const running = this.active.values().next().value;
      if (running) this.emit(running.state);
    });
  }

  private pump(): void {
    while (this.queue.length && this.active.size < this.concurrency) {
      const task = this.queue.shift()!;
      const controller = new AbortController();
      const state: Extract<TranslationState, { state: "running" }> = { state: "running", docId: task.docId, message: "正在准备翻译" };
      this.active.set(task.docId, { controller, state });
      this.emit(state);
      void this.runTranslation(task.docId, task.settings, controller.signal, task.untranslatedOnly).then((result) => {
        this.finish(task.docId, { state: "success", docId: task.docId, elapsedMs: result.elapsedMs });
        task.resolve(result);
      }, (error: unknown) => {
        const message = translationError(error);
        this.finish(task.docId, { state: "error", docId: task.docId, message });
        task.reject(new Error(message));
      });
    }
  }

  private finish(docId: string, state: TranslationState): void {
    const task = this.active.get(docId);
    if (state.state === "success") this.succeeded++;
    else if (task?.controller.signal.aborted) this.cancelled++;
    else {
      this.failed++;
      if (state.state === "error") this.errors = [...this.errors, `${task?.state.title || docId}：${state.message}`].slice(-5);
    }
    this.active.delete(docId);
    this.pump();
    const remaining = this.active.values().next().value;
    const final = this.total > 1 && (this.failed || this.cancelled)
      ? { state: "error" as const, docId, message: `翻译结束：成功 ${this.succeeded} 篇，失败 ${this.failed} 篇，取消 ${this.cancelled} 篇` }
      : state;
    this.emit(remaining?.state ?? final);
  }

  private emit(state: TranslationState): void {
    if (state.state === "running") {
      const task = this.active.get(state.docId);
      // Each process owns its state. Log lines without a percentage must not erase it.
      if (!task) return;
      task.state = { ...task.state, ...state, progress: state.progress ?? task.state.progress };
      // Keep the representative task stable; never select the last process to write output.
      state = { ...this.active.values().next().value!.state, queued: this.queue.length, active: this.active.size };
    }
    this.options.onState?.({ ...state, batch: {
      total: this.total, succeeded: this.succeeded, failed: this.failed, cancelled: this.cancelled,
      tasks: [...this.active.values()].map(({ state: task }) => ({
        docId: task.docId, title: task.title, citekey: task.citekey, progress: task.progress, message: task.message,
      })),
      errors: [...this.errors],
    } });
  }

  private async runTranslation(docId: string, settings: PluginSettings, signal: AbortSignal, untranslatedOnly = false): Promise<TranslationResult> {
    const paper = await this.options.readPaper(docId);
    signal.throwIfAborted();
    this.emit({ state: "running", docId, title: paper.canonical.title || paper.citekey || docId, citekey: paper.citekey, message: "正在准备翻译" } as any);
    if (untranslatedOnly && (paper.translation.mono || paper.translation.dual)) throw new Error("该论文已有译文，已跳过批量翻译");
    const pdf = translationSource(paper);
    const fs = requireNode<typeof import("node:fs")>("fs", this.requireFn);
    const path = requireNode<typeof import("node:path")>("path", this.requireFn);
    const os = requireNode<typeof import("node:os")>("os", this.requireFn);
    const workspace = await this.kernel.getWorkspaceInfo();
    signal.throwIfAborted();
    const dataRoot = path.resolve(workspace.workspaceDir, "data");
    const pdfPath = path.resolve(dataRoot, pdf.assetAddress);
    if (!isWithin(dataRoot, pdfPath, path.sep)) throw new Error("PDF 资源路径越出工作空间");
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF 文件不存在：${pdf.assetAddress}`);
    const executable = await resolveExecutable(settings.pdf2zhPath, this.requireFn);
    const service = selectedPdf2zhService(settings);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-paper-translate-"));
    const configPath = preparePdf2zhConfig(settings, service, this.options.getSecret, fs, path, os);
    const languages = translationLanguages(settings);
    const args = [
      "-o", outputDir,
      "-s", service,
      "-li", languages.source,
      "-lo", languages.target,
      "--thread", String(normalizeTranslationThreads(settings.translationThreads)),
      ...configArgs(configPath),
      ...withoutConfig(extractThreadArgs(settings.pdf2zhArgs).args, Boolean(configPath)),
      pdfPath,
    ];
    const startedAt = Date.now();
    this.emit({ state: "running", docId, message: "正在启动 pdf2zh" });
    try {
      signal.throwIfAborted();
      await this.spawn(executable, args, docId, settings);
      signal.throwIfAborted();
      this.emit({ state: "running", docId, message: "正在保存译稿" });
      const outputs = locateOutputs(outputDir, path.basename(pdfPath, path.extname(pdfPath)), fs, path);
      if (!outputs.mono) throw new Error("pdf2zh 未生成单语 PDF");
      validatePdf(outputs.mono, fs);
      if (outputs.dual) validatePdf(outputs.dual, fs);
      const monoBytes = new Uint8Array(fs.readFileSync(outputs.mono));
      const monoName = `${sanitizeDocumentName(paper.citekey)}-mono.pdf`;
      const mono = await this.kernel.uploadAsset(settings.translationAssetsDir, monoBytes, monoName, "application/pdf");
      signal.throwIfAborted();
      let dual: string | undefined;
      if (settings.translationDual && outputs.dual) {
        const dualBytes = new Uint8Array(fs.readFileSync(outputs.dual));
        const dualName = `${sanitizeDocumentName(paper.citekey)}-dual.pdf`;
        dual = await this.kernel.uploadAsset(settings.translationAssetsDir, dualBytes, dualName, "application/pdf");
      }
      signal.throwIfAborted();
      const commit = async () => {
        // Share the import/editor queue so attachment edits cannot be overwritten
        // between this fresh read and persistence.
        const latest = await this.options.readPaper(docId);
        signal.throwIfAborted();
        if (translationSource(latest).assetAddress !== pdf.assetAddress) {
          throw new Error("翻译期间论文原稿已更改，本次译稿未关联，请使用当前原稿重新翻译");
        }
        const previousTranslation = { ...latest.translation };
        latest.translation = {
          mono, dual, executable, args, completedAt: new Date().toISOString(),
          monoTitle: latest.translation.monoTitle, dualTitle: dual ? latest.translation.dualTitle : undefined,
        };
        await this.options.persist(docId, latest);
        return settings.autoDeleteOldTranslations
          ? await this.cleanupOldTranslations(previousTranslation, latest.translation, latest.attachments.map(item => item.assetAddress))
          : { deleted: [], warnings: [] };
      };
      const cleanup = this.options.withPaperLock ? await this.options.withPaperLock(commit) : await commit();
      const elapsedMs = Date.now() - startedAt;
      return {
        mono,
        dual,
        elapsedMs,
        deletedOldAssets: cleanup.deleted,
        cleanupWarnings: cleanup.warnings,
      };
    } finally {
      try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* system tmp cleanup */ }
    }
  }

  cancel(): void {
    for (const task of this.queue.splice(0)) {
      this.cancelled++;
      task.reject(new Error("翻译已取消"));
    }
    for (const task of this.active.values()) {
      task.controller.abort(new Error("翻译已取消"));
      task.child?.kill("SIGTERM");
    }
    const running = this.active.values().next().value;
    if (running) this.emit(running.state);
  }

  private async spawn(executable: string, args: string[], docId: string, settings: PluginSettings): Promise<void> {
    const childProcess = requireNode<typeof import("node:child_process")>("child_process", this.requireFn);
    const shellEnv = await resolveShellEnvironment(this.requireFn);
    return new Promise((resolve, reject) => {
      const child = (this.options.spawnProcess ?? childProcess.spawn)(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildPdf2zhEnv(settings, this.options.getSecret, shellEnv),
      });
      const task = this.active.get(docId);
      if (task) task.child = child;
      let stderr = "";
      const handleOutput = (chunk: Uint8Array) => {
        const line = new TextDecoder().decode(chunk);
        const progress = parseProgress(line);
        this.emit({
          state: "running",
          docId,
          progress,
          message: progress == null ? line.trim().slice(-160) || "翻译中" : `翻译中 ${progress}%`,
        });
      };
      child.stdout?.on("data", handleOutput);
      child.stderr?.on("data", (chunk: Uint8Array) => {
        const text = new TextDecoder().decode(chunk);
        stderr = `${stderr}${text}`.slice(-8_000);
        handleOutput(chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) reject(new Error(`pdf2zh 已中止 (${signal})`));
        else if (code === 0) resolve();
        else reject(new Error(`pdf2zh 退出码 ${String(code)}：${stderr.trim().slice(-1000)}`));
      });
    });
  }

  private async cleanupOldTranslations(
    previous: PaperData["translation"],
    current: PaperData["translation"],
    attachments: string[] = [],
  ): Promise<{ deleted: string[]; warnings: string[] }> {
    const currentPaths = new Set(
      [current.mono, current.dual]
        .filter((value): value is string => Boolean(value))
        .map((address) => translationWorkspacePath(address)),
    );
    const oldAddresses = new Set([previous.mono, previous.dual].filter((value): value is string => Boolean(value)));
    const deleted: string[] = [];
    const warnings: string[] = [];
    for (const address of oldAddresses) {
      try {
        const path = translationWorkspacePath(address);
        if (currentPaths.has(path) || attachments.some(item => item.replace(/^\/+/, "") === address.replace(/^\/+/, ""))) continue;
        await this.kernel.removeWorkspaceFile(path);
        deleted.push(address);
      } catch (error) {
        const detail = errorMessage(error);
        warnings.push(`${address}：${detail}`);
        console.warn("[paper-manager] 旧翻译资源删除失败", address, error);
      }
    }
    return { deleted, warnings };
  }
}

function selectedPdf2zhService(settings: PluginSettings): string { const config = settings.pdf2zhConfig; if (config && Array.isArray(config.translators)) { const first = config.translators[0]; if (first && typeof first === "object" && typeof (first as Record<string, unknown>).name === "string") return String((first as Record<string, unknown>).name); } if (config && typeof config.translator === "string") return config.translator; return settings.translateService; }

/**
 * pdf2zh 的 -li/-lo 是唯一生效的语言来源：配置里的 PDF2ZH_LANG_FROM/TO 只被
 * 它的 GUI（gui.py）读取，命令行路径完全不读（实测：配置写 klingon→vulcan 且
 * 不传 -li/-lo 时，translator 收到的仍是 argparse 默认的 en→zh；传 -li ja -lo ko
 * 后收到 ja→ko）。因此配置里的语言键只是插件自己的存储，必须显式转成 -li/-lo。
 * 优先级：托管配置（设置面板编辑）→ 插件翻译设置 → 硬默认值。
 */
function translationLanguages(settings: PluginSettings): { source: string; target: string } {
  const config = settings.pdf2zhConfig ?? {};
  const pick = (key: "PDF2ZH_LANG_FROM" | "PDF2ZH_LANG_TO", fallback: string, hardDefault: string): string => {
    const configured = config[key];
    const raw = typeof configured === "string" && configured.trim() ? configured : fallback;
    return pdf2zhLanguageCode(raw) || hardDefault;
  };
  return {
    source: pick("PDF2ZH_LANG_FROM", settings.translateFrom, "en"),
    target: pick("PDF2ZH_LANG_TO", settings.translateTo, "zh"),
  };
}

function configArgs(configPath?: string): string[] {
  return configPath ? ["--config", configPath] : [];
}

/**
 * pdf2zh 的 BaseTranslator.set_envs 会用配置里该服务的 envs 整表替换内置默认表，
 * 且只遍历替换后仍存在的键去读取 os.environ；配置缺少凭据键名时，插件注入的密钥
 * 会被忽略并抛 KeyError。因此由插件管理的配置必须补齐凭据键名占位（值保持 null）。
 * 配置不可写时退回临时配置文件，保证本次翻译仍能带着正确的 envs 启动。
 */
function preparePdf2zhConfig(
  settings: PluginSettings,
  service: string,
  getSecret: ((name: string) => string) | undefined,
  fs: Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "mkdirSync" | "writeFileSync" | "mkdtempSync">,
  path: Pick<typeof import("node:path"), "dirname" | "join">,
  os: Pick<typeof import("node:os"), "tmpdir">,
): string | undefined {
  const resolved = resolvedSecrets(settings, getSecret);
  const normalize = (config: Record<string, unknown>): Record<string, unknown> =>
    scrubInjectedSecrets(ensureCredentialPlaceholders(config, service), service, resolved);
  const target = settings.pdf2zhConfigPath?.trim();
  if (target) {
    try {
      const exists = fs.existsSync(target);
      const current = exists ? asConfigRecord(JSON.parse(String(fs.readFileSync(target, "utf8")))) : asConfigRecord(settings.pdf2zhConfig);
      const next = normalize(current);
      if (!exists || JSON.stringify(next) !== JSON.stringify(current)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      }
      return target;
    } catch (error) {
      console.warn("[paper-manager] 托管 pdf2zh 配置不可用，改用临时配置", target, error);
    }
  }
  const base = asConfigRecord(settings.pdf2zhConfig);
  if (!Object.keys(base).length) return undefined;
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-pdf2zh-config-")), "config.json");
    fs.writeFileSync(file, `${JSON.stringify(normalize(base), null, 2)}\n`, "utf8");
    return file;
  } catch (error) {
    console.warn("[paper-manager] 无法写入 pdf2zh 临时配置，将直接使用插件设置", error);
    return undefined;
  }
}

function asConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value as Record<string, unknown>) : {};
}

function withoutConfig(args: string[], managed: boolean): string[] {
  if (!managed) return args;
  const output: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config" || args[i] === "-c") { i += 1; continue; }
    if (args[i]?.startsWith("--config=")) continue;
    output.push(args[i]!);
  }
  return output;
}

function buildPdf2zhEnv(settings: PluginSettings, getSecret?: (name: string) => string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...resolvedSecrets(settings, getSecret) };
}

/**
 * 解析出本次翻译可提供的密钥（环境变量名 → 值）。设置界面的映射是主来源；
 * translator.envs 里以密钥名作为值的旧版本映射作为补充。
 */
function resolvedSecrets(settings: PluginSettings, getSecret?: (name: string) => string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, name] of Object.entries(settings.pdf2zhSecretNames ?? {})) {
    const envKey = canonicalSecretEnvKey(key);
    const secretName = name.trim();
    if (!envKey || !secretName) continue;
    const value = getSecret?.(secretName)?.trim();
    if (value) resolved[envKey] = value;
  }
  const translators = settings.pdf2zhConfig?.translators;
  if (Array.isArray(translators)) for (const translator of translators) {
    const envs = translator && typeof translator === "object" ? (translator as Record<string, unknown>).envs : undefined;
    if (!envs || typeof envs !== "object") continue;
    for (const [key, candidate] of Object.entries(envs as Record<string, unknown>)) {
      if (!isSecretKey(key) || typeof candidate !== "string" || !candidate.trim()) continue;
      const value = getSecret?.(candidate.trim())?.trim();
      if (value) resolved[canonicalSecretEnvKey(key)] = value;
    }
  }
  return resolved;
}

/** pdf2zh 读取进程环境后会把密钥回写到配置文件；能由环境提供的密钥在启动前一律清空。 */
function scrubInjectedSecrets(config: Record<string, unknown>, service: string, resolved: Record<string, string>): Record<string, unknown> {
  const keys = Object.keys(resolved);
  if (!keys.length) return config;
  const list = Array.isArray(config.translators) ? (config.translators as unknown[]) : [];
  const index = list.findIndex(entry => entry && typeof entry === "object" && !Array.isArray(entry)
    && String((entry as Record<string, unknown>).name ?? "").toLowerCase() === service.trim().toLowerCase());
  if (index < 0) return config;
  const entry = { ...(list[index] as Record<string, unknown>) };
  const envs = entry.envs && typeof entry.envs === "object" && !Array.isArray(entry.envs)
    ? { ...(entry.envs as Record<string, unknown>) } : {};
  let changed = false;
  for (const key of keys) {
    if (typeof envs[key] === "string" && envs[key]) { envs[key] = null; changed = true; }
  }
  if (!changed) return config;
  entry.envs = envs;
  list[index] = entry;
  config.translators = list;
  return config;
}

export function translationWorkspacePath(address: string): string {
  const clean = address.replace(/\\/g, "/").replace(/^\/+/, "").split(/[?#]/, 1)[0] ?? "";
  const segments = clean.split("/");
  if (!clean || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`翻译资源路径不合法：${address}`);
  }
  if (!/-(?:mono|dual)\.pdf$/i.test(segments.at(-1) ?? "")) {
    throw new Error(`仅删除插件生成的翻译 PDF：${address}`);
  }
  return `/data/${segments.join("/")}`;
}

export function parseProgress(output: string): number | undefined {
  const values = [...output.matchAll(/(?:^|\D)(100|\d{1,2})(?:\.\d+)?%/g)].map((match) => Number(match[1]));
  const last = values.at(-1);
  return last != null && last >= 0 && last <= 100 ? last : undefined;
}

export async function resolveExecutable(
  configured: string,
  requireFn: NodeRequire,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const paths = requireNode<typeof import("node:path")>("path", requireFn);
  const path = platform === "win32" ? paths.win32 : paths.posix;
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const childProcess = requireNode<typeof import("node:child_process")>("child_process", requireFn);
  const value = (configured.trim().replace(/^(["'])(.*)\1$/, "$2").trim()) || "pdf2zh";
  const isFile = (candidate: string): boolean => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  };
  const isBatch = (candidate: string) => platform === "win32" && /\.(cmd|bat)$/i.test(candidate);
  const batchError = () => new Error("不支持 .cmd/.bat 启动脚本，请填写 pip/uv 安装的 pdf2zh.exe 路径");
  if (isBatch(value)) throw batchError();
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    if (isFile(value)) return value;
    throw new Error(`pdf2zh 可执行文件不存在或不是文件：${value}`);
  }
  const lookup = platform === "win32" ? "where.exe" : "which";
  const matches = await new Promise<string[]>((resolve) => {
    childProcess.execFile(lookup, [value], {
      encoding: "utf8", shell: false, windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
    }, (error, stdout) => resolve(error ? [] : stdout.trim().split(/\r?\n/).filter(Boolean)));
  });
  const candidates = [...matches,
    path.join(os.homedir(), ".local", "bin", value),
    ...(platform === "win32" && !/\.exe$/i.test(value)
      ? [path.join(os.homedir(), ".local", "bin", `${value}.exe`)] : []),
  ].filter(isFile);
  if (platform === "win32") {
    const exe = candidates.find((candidate) => /\.exe$/i.test(candidate));
    if (exe) return exe;
  }
  const resolved = candidates.find((candidate) => !isBatch(candidate));
  if (resolved) return resolved;
  if (candidates.some(isBatch)) throw batchError();
  throw new Error("未检测到 pdf2zh，请先安装并在设置中填写可执行路径");
}

function locateOutputs(
  directory: string,
  originalBase: string,
  fs: typeof import("node:fs"),
  path: typeof import("node:path"),
): { mono?: string; dual?: string } {
  const files = fs.readdirSync(directory).filter((file) => file.toLowerCase().endsWith(".pdf"));
  const mono = files.find((file) => file === `${originalBase}-mono.pdf`)
    ?? files.find((file) => /-mono\.pdf$/i.test(file));
  const dual = files.find((file) => file === `${originalBase}-dual.pdf`)
    ?? files.find((file) => /-dual\.pdf$/i.test(file));
  return {
    mono: mono ? path.join(directory, mono) : undefined,
    dual: dual ? path.join(directory, dual) : undefined,
  };
}

function validatePdf(pathname: string, fs: typeof import("node:fs")): void {
  const descriptor = fs.openSync(pathname, "r");
  try {
    const buffer = Buffer.alloc(5);
    const count = fs.readSync(descriptor, buffer, 0, 5, 0);
    if (count !== 5 || buffer.toString("ascii") !== "%PDF-") throw new Error(`输出不是有效 PDF：${pathname}`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isWithin(root: string, target: string, separator: string): boolean {
  return target === root || target.startsWith(`${root}${separator}`);
}

function translationError(error: unknown): string {
  const message = errorMessage(error);
  if (/ENOENT|未检测到|不存在/.test(message)) return `${message}；请检查 pdf2zh 安装与路径`;
  if (/KeyError|API_KEY|AUTH_KEY|ACCESS_TOKEN|SECRET_KEY|密钥/.test(message)) return `${message}；请在设置中填写对应服务的思源「密钥和变量」名称`;
  if (/huggingface|hf-mirror|download|Failed to (?:download|load)|model.*(?:not found|missing)/i.test(message)) return `${message}；国内网络可设置 HF_ENDPOINT=https://hf-mirror.com`;
  return message;
}
