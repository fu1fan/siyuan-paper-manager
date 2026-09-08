import type { ChildProcess } from "node:child_process";
import type { PaperData } from "../types/paper";
import type { PluginSettings } from "../types/settings";
import type { TranslationState } from "../types/status";
import { getNodeRequire, type NodeRequire, requireNode } from "../core/env";
import { KernelClient } from "../core/kernel";
import { sanitizeDocumentName } from "../core/naming";

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
  persist: (docId: string, paper: PaperData) => Promise<void>;
}

interface QueuedTranslation {
  docId: string;
  settings: PluginSettings;
  resolve: (result: TranslationResult) => void;
  reject: (error: Error) => void;
}

export class TranslatorService {
  private readonly requireFn: NodeRequire;
  private child: ChildProcess | null = null;
  private activeDocId: string | null = null;
  private readonly queue: QueuedTranslation[] = [];
  private pumping = false;
  private cancellation: AbortController | null = null;
  private lastRunning: { docId: string; progress?: number; message?: string } | null = null;

  constructor(private readonly kernel: KernelClient, private readonly options: TranslatorOptions) {
    const requireFn = options.requireFn ?? getNodeRequire();
    if (!requireFn) throw new Error("Node 子进程不可用，仅支持思源桌面端");
    this.requireFn = requireFn;
  }

  isRunning(): boolean {
    return this.activeDocId !== null || this.queue.length > 0;
  }

  /** 多篇论文同时触发翻译时排队串行执行，状态栏显示当前进度与队列长度。 */
  translate(docId: string, settings: PluginSettings): Promise<TranslationResult> {
    if (this.activeDocId === docId || this.queue.some((task) => task.docId === docId)) {
      return Promise.reject(new Error("该论文已在翻译队列中"));
    }
    return new Promise<TranslationResult>((resolve, reject) => {
      this.queue.push({ docId, settings: structuredClone(settings), resolve, reject });
      // 让状态栏立即反映新的队列长度；沿用最近一次进度，避免清空百分比
      if (this.activeDocId && this.lastRunning) this.emit({ state: "running", ...this.lastRunning });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        this.activeDocId = task.docId;
        this.cancellation = new AbortController();
        this.emit({ state: "running", docId: task.docId, message: "正在准备翻译" });
        try {
          task.resolve(await this.runTranslation(task.docId, task.settings, this.cancellation.signal));
        } catch (error) {
          const message = translationError(error);
          this.emit({ state: "error", docId: task.docId, message });
          task.reject(new Error(message));
        } finally {
          this.activeDocId = null;
          this.cancellation = null;
          this.child = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private emit(state: TranslationState): void {
    if (state.state === "running") {
      this.lastRunning = { docId: state.docId, progress: state.progress, message: state.message };
      this.options.onState?.({ ...state, queued: this.queue.length });
      return;
    }
    this.lastRunning = null;
    this.options.onState?.(state);
  }

  private async runTranslation(docId: string, settings: PluginSettings, signal: AbortSignal): Promise<TranslationResult> {
    const paper = await this.options.readPaper(docId);
    signal.throwIfAborted();
    const pdf = paper.attachments.find((attachment) => attachment.mimeType === "application/pdf");
    if (!pdf) throw new Error("当前论文没有可翻译的 PDF 附件");
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
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-paper-translate-"));
    const args = [
      "-o", outputDir,
      "-li", settings.translateFrom,
      "-lo", settings.translateTo,
      "-s", settings.translateService,
      ...settings.pdf2zhArgs,
      pdfPath,
    ];
    const startedAt = Date.now();
    this.emit({ state: "running", docId, message: "正在启动 pdf2zh" });
    try {
      signal.throwIfAborted();
      await this.spawn(executable, args, docId);
      signal.throwIfAborted();
      const outputs = locateOutputs(outputDir, path.basename(pdfPath, path.extname(pdfPath)), fs, path);
      if (!outputs.mono) throw new Error("pdf2zh 未生成单语 PDF");
      validatePdf(outputs.mono, fs);
      if (outputs.dual) validatePdf(outputs.dual, fs);
      const monoBytes = new Uint8Array(fs.readFileSync(outputs.mono));
      const monoName = `${sanitizeDocumentName(paper.citekey)}-mono.pdf`;
      const mono = await this.kernel.uploadAsset(settings.translationAssetsDir, monoBytes, monoName, "application/pdf");
      let dual: string | undefined;
      if (settings.translationDual && outputs.dual) {
        const dualBytes = new Uint8Array(fs.readFileSync(outputs.dual));
        const dualName = `${sanitizeDocumentName(paper.citekey)}-dual.pdf`;
        dual = await this.kernel.uploadAsset(settings.translationAssetsDir, dualBytes, dualName, "application/pdf");
      }
      signal.throwIfAborted();
      // 翻译可能持续很久，保存时重新读论文，保留期间新增的附件和数据库编辑。
      const latest = await this.options.readPaper(docId);
      signal.throwIfAborted();
      const previousTranslation = { ...latest.translation };
      latest.translation = {
        mono,
        dual,
        executable,
        args,
        completedAt: new Date().toISOString(),
      };
      await this.options.persist(docId, latest);
      const cleanup = settings.autoDeleteOldTranslations
        ? await this.cleanupOldTranslations(previousTranslation, latest.translation)
        : { deleted: [], warnings: [] };
      const elapsedMs = Date.now() - startedAt;
      this.emit({ state: "success", docId, elapsedMs });
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
    for (const task of this.queue.splice(0)) task.reject(new Error("翻译已取消"));
    this.cancellation?.abort(new Error("翻译已取消"));
    this.child?.kill("SIGTERM");
  }

  private spawn(executable: string, args: string[], docId: string): Promise<void> {
    const childProcess = requireNode<typeof import("node:child_process")>("child_process", this.requireFn);
    return new Promise((resolve, reject) => {
      const child = (this.options.spawnProcess ?? childProcess.spawn)(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
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
        if (currentPaths.has(path)) continue;
        await this.kernel.removeWorkspaceFile(path);
        deleted.push(address);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`${address}：${detail}`);
        console.warn("[paper-manager] 旧翻译资源删除失败", address, error);
      }
    }
    return { deleted, warnings };
  }
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
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|未检测到|不存在/.test(message)) return `${message}；请检查 pdf2zh 安装与路径`;
  if (/model|huggingface|download/i.test(message)) return `${message}；国内网络可设置 HF_ENDPOINT=https://hf-mirror.com`;
  return message;
}
