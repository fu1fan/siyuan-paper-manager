import { uvInstallerScriptUrl } from "./download-presets";
import { getNodeRequire, requireNode, type NodeRequire } from "../core/env";
import { PLUGIN_NAME } from "../constants";

export type PythonSupport = "supported" | "unverified" | "unsupported";

export interface PythonCandidate {
  path: string;
  aliases: string[];
  version: string;
  major: number;
  minor: number;
  arch: string;
  source: string;
  support: PythonSupport;
  global: boolean;
}

export interface CommandResult { stdout: string; stderr: string; code: number; }
export interface InstalledPdf2zh { executable: string; pythonPath?: string; version?: string; toolDir?: string; }

/**
 * uv 的调用形式：PATH 上的可执行文件、user-site Scripts 里的绝对路径，
 * 或解释器模块调用（python -m uv，此时 file 是 python 路径）。
 */
export interface UvCommand { file: string; argsPrefix: string[]; display: string; }

// pdf2zh 1.9.11 imports TextTranslateRequest at startup. Newer Tencent SDKs
// removed it; use the same compatible version pinned by upstream.
export const PDF2ZH_COMPAT_REQUIREMENT = "tencentcloud-sdk-python-tmt==3.1.70";

export function isPdf2zhDependencyError(detail: string): boolean {
  return /ImportError:\s*cannot import name ['"]TextTranslate(?:Request|Response)['"] from ['"]tencentcloud\.tmt\.v20180321\.models['"]/.test(detail);
}

const dependencyRepairs = new Map<string, Promise<boolean>>();

/** Repair only the identified SDK incompatibility inside a dedicated tool/venv. */
export function repairPdf2zhDependency(
  executable: string,
  detail: string,
  requireFn: NodeRequire = getNodeRequire()!,
  onLine?: (line: string) => void,
): Promise<boolean> {
  if (!isPdf2zhDependencyError(detail)) return Promise.resolve(false);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const key = realpathKey(fs, executable);
  const existing = dependencyRepairs.get(key);
  if (existing) return existing;
  const repair = performDependencyRepair(executable, requireFn, onLine);
  dependencyRepairs.set(key, repair);
  void repair.finally(() => dependencyRepairs.delete(key)).catch(() => {});
  return repair;
}

async function performDependencyRepair(executable: string, requireFn: NodeRequire, onLine?: (line: string) => void): Promise<boolean> {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const win = os.platform() === "win32";
  const uv = await findUv(requireFn);
  if (!uv) throw new Error(`已识别腾讯云 SDK 依赖错误；未找到 uv，请在 pdf2zh 环境安装 ${PDF2ZH_COMPAT_REQUIREMENT}`);
  const roots = [path.dirname(path.dirname(realpathKey(fs, executable)))];
  const paths = deploymentPaths(requireFn);
  if (sameExecutable(executable, path.join(paths.bin, win ? "pdf2zh.exe" : "pdf2zh"), requireFn)) roots.push(path.join(paths.tools, "pdf2zh"));
  // On Windows uv copies an .exe launcher into its bin dir rather than linking
  // it. Resolve the matching external uv tool without changing its directories.
  const externalBin = await runUv(uv, ["tool", "dir", "--bin"], requireFn, 5_000, false);
  if (externalBin.code === 0 && sameExecutable(executable, path.join(externalBin.stdout.trim(), win ? "pdf2zh.exe" : "pdf2zh"), requireFn)) {
    const externalTools = await runUv(uv, ["tool", "dir"], requireFn, 5_000, false);
    if (externalTools.code === 0 && externalTools.stdout.trim()) roots.push(path.join(externalTools.stdout.trim(), "pdf2zh"));
  }
  for (const root of new Set(roots)) {
    const python = path.join(root, win ? "Scripts" : "bin", win ? "python.exe" : "python");
    if (!fs.existsSync(path.join(root, "pyvenv.cfg")) || !fs.existsSync(python)) continue;
    const validation = await exec(python, ["-c", "import sys,importlib.metadata as m; print(sys.prefix); print(sys.prefix != sys.base_prefix); print(m.version('pdf2zh'))"], requireFn, 8_000);
    const [prefix, isolated, version] = validation.stdout.trim().split(/\r?\n/);
    if (validation.code !== 0 || isolated !== "True" || !version || !prefix || !sameExecutable(prefix, root, requireFn)) continue;
    onLine?.("检测到腾讯云 SDK 接口不兼容，正在自动修复 pdf2zh 独立环境…");
    const [file, args] = uvInvocation(uv, ["pip", "install", "--python", python, PDF2ZH_COMPAT_REQUIREMENT]);
    const result = await spawnLogged(file, args, { requireFn, timeoutMs: 180_000, onLine });
    if (result.code !== 0) throw new Error(`pdf2zh 依赖自动修复失败：${result.stderr || result.stdout}`);
    return true;
  }
  throw new Error(`已识别腾讯云 SDK 依赖错误，但无法确认 pdf2zh 的独立 Python 环境；请在原环境安装 ${PDF2ZH_COMPAT_REQUIREMENT}`);
}

type ExecFile = (file: string, args: string[], options: Record<string, unknown>, callback: (error: any, stdout: string, stderr: string) => void) => void;

let shellEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * Electron apps launched by Finder inherit launchd's minimal environment.
 * VS Code resolves the user's login-shell environment before running its
 * Python locators; do the same for the standalone SiYuan renderer.
 */
export function resolveShellEnvironment(requireFn: NodeRequire = getNodeRequire()!): Promise<NodeJS.ProcessEnv> {
  if (shellEnvironmentPromise) return shellEnvironmentPromise;
  if (process.platform === "win32") {
    shellEnvironmentPromise = Promise.resolve({ ...process.env });
    return shellEnvironmentPromise;
  }
  shellEnvironmentPromise = new Promise(resolve => {
    const cp = requireNode<{ execFile: ExecFile }>("child_process", requireFn);
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    cp.execFile(shell, ["-ilc", "env -0"], { shell: false, encoding: "buffer", timeout: 8_000, maxBuffer: 512 * 1024 }, (error, stdout) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (!error) {
        for (const entry of Buffer.from(stdout as unknown as Uint8Array).toString("utf8").split("\0")) {
          const index = entry.indexOf("=");
          if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
        }
      }
      resolve(env);
    });
  });
  return shellEnvironmentPromise;
}

async function exec(file: string, args: string[], requireFn: NodeRequire, timeout = 30_000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const cp = requireNode<{ execFile: ExecFile }>("child_process", requireFn);
  const commandEnv = env ?? await resolveShellEnvironment(requireFn);
  return new Promise(resolve => cp.execFile(file, args, { shell: false, windowsHide: true, encoding: "utf8", timeout, maxBuffer: 256 * 1024, env: commandEnv }, (error, stdout, stderr) => {
    resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: typeof error?.code === "number" ? error.code : error ? 1 : 0 });
  }));
}

export interface SpawnLoggedOptions {
  requireFn: NodeRequire;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  maxLogChars?: number;
}

/**
 * Run a long-lived command (install/upgrade) with combined stdout+stderr streamed
 * line-by-line to onLine. `\r`-separated progress updates are treated as line
 * breaks so progress bars stay readable in the UI log.
 * Returns CommandResult: stdout 是完整日志（尾部截断到 maxLogChars），stderr 是日志末尾
 * 4000 字符（供错误消息展示）。
 */
export async function spawnLogged(file: string, args: string[], options: SpawnLoggedOptions): Promise<CommandResult> {
  const cp = requireNode<typeof import("node:child_process")>("child_process", options.requireFn);
  const env = options.env ?? await resolveShellEnvironment(options.requireFn);
  const maxLogChars = options.maxLogChars ?? 256 * 1024;
  return new Promise((resolve) => {
    let log = "";
    let pending = "";
    const decoder = new TextDecoder();
    const emitLine = (line: string) => {
      if (!line.trim()) return;
      log = `${log}${line}\n`.slice(-maxLogChars);
      options.onLine?.(line);
    };
    const push = (text: string) => {
      pending += text;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) emitLine(part);
    };
    const flush = () => { push(decoder.decode()); if (pending) { emitLine(pending); pending = ""; } };
    if (options.signal?.aborted) return resolve({ stdout: "", stderr: "安装已取消", code: 1 });
    let child: ReturnType<typeof cp.spawn>;
    try {
      child = cp.spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env });
    } catch (error) {
      emitLine(String(error));
      return resolve({ stdout: log, stderr: log.slice(-4_000), code: 1 });
    }
    const timeoutMs = options.timeoutMs ?? 60_000;
    let stopped = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      stopped = true;
      push(`\n[${message}]\n`);
      if (process.platform === "win32" && child.pid) {
        cp.execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
        forceTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already stopped */ } }, 3000);
      } else child.kill();
    };
    const cancel = () => stop("安装已取消");
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop(`超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已终止`), timeoutMs);
    const cleanup = () => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", cancel); };
    child.stdout?.on("data", (chunk: Uint8Array) => push(decoder.decode(chunk, { stream: true })));
    child.stderr?.on("data", (chunk: Uint8Array) => push(decoder.decode(chunk, { stream: true })));
    child.once("error", (error) => { cleanup(); push(String(error)); flush(); resolve({ stdout: log, stderr: log.slice(-4_000), code: 1 }); });
    child.once("close", (code) => { cleanup(); flush(); resolve({ stdout: log, stderr: log.slice(-4_000), code: stopped ? 1 : code ?? 1 }); });
  });
}

function uvInvocation(uv: UvCommand, args: string[]): [string, string[]] {
  return [uv.file, [...uv.argsPrefix, ...args]];
}

async function runUv(uv: UvCommand, args: string[], requireFn: NodeRequire, timeout = 30_000, managed = true): Promise<CommandResult> {
  const [file, fullArgs] = uvInvocation(uv, args);
  return exec(file, fullArgs, requireFn, timeout, managed ? await managedEnvironment(requireFn) : undefined);
}

/** Machine-local paths: Python environments must never sync with a workspace. */
export function deploymentPaths(requireFn: NodeRequire = getNodeRequire()!) {
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const platform = os.platform();
  const home = os.homedir();
  const base = platform === "win32" ? process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support")
    : process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const root = path.join(base, PLUGIN_NAME, "pdf2zh");
  const bootstrap = path.join(root, "bootstrap");
  return { root, uvBin: path.join(root, "uv-bin"), uv: path.join(root, "uv-bin", platform === "win32" ? "uv.exe" : "uv"), tools: path.join(root, "tools"), bin: path.join(root, "bin"), bootstrap,
    python: path.join(bootstrap, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python") };
}

async function managedEnvironment(requireFn: NodeRequire): Promise<NodeJS.ProcessEnv> {
  const paths = deploymentPaths(requireFn);
  return { ...await resolveShellEnvironment(requireFn), UV_TOOL_DIR: paths.tools, UV_TOOL_BIN_DIR: paths.bin };
}

export function sameExecutable(a: string, b: string, requireFn: NodeRequire = getNodeRequire()!): boolean {
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const key = (p: string) => {
    const resolved = realpathKey(fs, path.resolve(p));
    return os.platform() === "win32" ? resolved.toLowerCase() : resolved;
  };
  return key(a) === key(b);
}

/**
 * pip --user 安装的工具落在解释器自己的 user scripts 目录（Windows 上通常是
 * %APPDATA%\Python\Python3x\Scripts），这个目录一般不在 GUI 进程的 PATH 里，
 * 所以 PATH 查不到 uv 时必须直接问解释器。
 */
async function userScriptsDir(pythonPath: string, requireFn: NodeRequire): Promise<string | undefined> {
  const result = await exec(pythonPath, ["-c", "import sysconfig,sys; print(sysconfig.get_path('scripts', 'nt_user' if sys.platform == 'win32' else 'posix_user'))"], requireFn, 8_000);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export async function findUv(requireFn: NodeRequire = getNodeRequire()!, pythonPath?: string): Promise<UvCommand | null> {
  const managedUv = deploymentPaths(requireFn).uv;
  const names = [managedUv, ...(process.platform === "win32" ? ["uv.exe", "uv"] : ["uv"])];
  for (const name of names) {
    const result = await exec(name, ["--version"], requireFn, 5_000);
    if (result.code === 0) return { file: name, argsPrefix: [], display: name };
  }
  const bootstrap = deploymentPaths(requireFn).python;
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  if (fs.existsSync(bootstrap)) {
    const result = await exec(bootstrap, ["-m", "uv", "--version"], requireFn, 8_000);
    if (result.code === 0) return { file: bootstrap, argsPrefix: ["-m", "uv"], display: `${bootstrap} -m uv` };
  }
  if (pythonPath) {
    const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
    const path = requireNode<typeof import("node:path")>("path", requireFn);
    const scriptsDir = await userScriptsDir(pythonPath, requireFn);
    if (scriptsDir) {
      for (const name of process.platform === "win32" ? ["uv.exe", "uv"] : ["uv"]) {
        const candidate = path.join(scriptsDir, name);
        if (fs.existsSync(candidate)) return { file: candidate, argsPrefix: [], display: candidate };
      }
    }
    // 最后兜底：uv 的 PyPI 包支持 python -m uv 调用，不依赖 Scripts 目录。
    const moduleProbe = await exec(pythonPath, ["-m", "uv", "--version"], requireFn, 8_000);
    if (moduleProbe.code === 0) return { file: pythonPath, argsPrefix: ["-m", "uv"], display: `${pythonPath} -m uv` };
  }
  return null;
}

/** Published pdf2zh 1.9.11 declares >=3.10,<3.13. */
function pythonSupport(major: number, minor: number): PythonSupport {
  return major === 3 && minor >= 10 && minor < 13 ? "supported" : "unsupported";
}

export async function validateDeploymentPython(pythonPath: string, requireFn: NodeRequire = getNodeRequire()!): Promise<void> {
  const result = await exec(pythonPath, ["-c", PYTHON_PROBE], requireFn, 8_000);
  const version = result.stdout.trim().split("\t")[0]?.match(/^(\d+)\.(\d+)\.\d+$/);
  if (result.code !== 0 || !version) throw new Error("无法启动所选 Python，请检查解释器路径");
  if (pythonSupport(Number(version[1]), Number(version[2])) !== "supported") throw new Error("pdf2zh 需要 Python 3.10–3.12，请重新选择解释器");
}

/** 探测输出：版本\t架构\tsys.prefix。prefix 是同一安装跨 python/python3 文件名的合并键。 */
export const PYTHON_PROBE = "import platform,sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\\t{platform.machine()}\\t{sys.prefix}')";

function realpathKey(fs: Pick<typeof import("node:fs"), "realpathSync">, value: string): string {
  try { return fs.realpathSync.native(value); } catch { try { return fs.realpathSync(value); } catch { return value; } }
}

export async function scanPython(
  requireFn: NodeRequire = getNodeRequire()!,
  onProgress?: (done: number, total: number) => void,
): Promise<PythonCandidate[]> {
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const environment = await resolveShellEnvironment(requireFn);
  const candidates = new Map<string, { displayPath: string; source: string; aliases: Set<string> }>();
  const add = (value: string, source: string) => {
    const p = value.trim().replace(/^['"]|['"]$/g, "");
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return;
    const normalized = path.normalize(p);
    const key = realpathKey(fs, normalized);
    const current = candidates.get(key) ?? { displayPath: normalized, source, aliases: new Set<string>() };
    current.aliases.add(path.basename(normalized));
    candidates.set(key, current);
  };
  const addDir = (dir: string, source: string) => { if (!dir || !fs.existsSync(dir)) return; for (const name of os.platform() === "win32" ? ["python.exe", "python3.exe", "python3"] : ["python3", "python"]) add(path.join(dir, name), source); };
  // Same locator families as vscode-python: PATH, pyenv, conda, global venvs,
  // and platform-specific registry/store locations.
  for (const dir of (environment.PATH ?? "").split(path.delimiter)) addDir(dir, "PATH");
  const home = os.homedir();
  // mise is intentionally discovered by its install tree, like VS Code's
  // filesystem locators. The GUI process PATH often does not contain mise's
  // shims, while interpreters live under <data-dir>/installs/python/<version>.
  const miseData = environment.MISE_DATA_DIR || path.join(environment.XDG_DATA_HOME || path.join(home, ".local", "share"), "mise");
  const misePython = path.join(miseData, "installs", "python");
  if (fs.existsSync(misePython)) {
    for (const entry of fs.readdirSync(misePython, { withFileTypes: true })) {
      if (entry.isDirectory()) addDir(path.join(misePython, entry.name, os.platform() === "win32" ? "" : "bin"), "mise");
    }
  }
  // Some GUI shells do not load mise's activation hook. Ask mise itself for
  // installed versions as VS Code's manager locators do, then inspect the
  // resulting interpreter paths directly.
  const miseCommand = path.join(process.env.HOMEBREW_PREFIX || "/opt/homebrew", "bin", "mise");
  for (const command of ["mise", fs.existsSync(miseCommand) ? miseCommand : ""]) {
    if (!command) continue;
    const result = await exec(command, ["ls", "python", "--installed"], requireFn, 8_000, environment);
    if (result.code !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const version = line.trim().match(/^(\d+\.\d+(?:\.\d+)?)/)?.[1];
      if (!version) continue;
      add(os.platform() === "win32" ? path.join(misePython, version, "python.exe") : path.join(misePython, version, "bin", "python"), "mise");
    }
    break;
  }
  for (const dir of [path.join(home, ".pyenv", "versions"), path.join(home, ".local", "share", "pyenv", "versions")]) {
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) addDir(path.join(dir, entry.name, "bin"), "pyenv");
  }
  for (const dir of [environment.WORKON_HOME, path.join(home, "envs"), path.join(home, "Envs"), path.join(home, ".venvs"), path.join(home, ".virtualenvs"), path.join(home, ".local", "share", "virtualenvs")].filter(Boolean) as string[]) {
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) addDir(path.join(dir, entry.name, os.platform() === "win32" ? "Scripts" : "bin"), "global-venv");
  }
  for (const command of ["conda", "mamba"]) { const result = await exec(command, ["env", "list", "--json"], requireFn, 8_000); if (result.code === 0) { try { const dirs = JSON.parse(result.stdout).envs as string[]; for (const dir of dirs ?? []) addDir(os.platform() === "win32" ? dir : path.join(dir, "bin"), "conda"); } catch { /* ignore malformed manager output */ } } }
  if (os.platform() === "win32") {
    const result = await exec("reg", ["query", "HKCU\\Software\\Python\\PythonCore", "/s", "/v", "ExecutablePath"], requireFn, 8_000);
    for (const line of result.stdout.split(/\r?\n/)) { const match = line.match(/ExecutablePath\s+REG_SZ\s+(.+)$/i); if (match) add(match[1]!, "windows-registry"); }
    for (const dir of [environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps"), environment.ProgramFiles && path.join(environment.ProgramFiles, "WindowsApps")].filter(Boolean) as string[]) addDir(dir, "microsoft-store");
  }
  const commands: Array<[string, string[]]> = os.platform() === "win32" ? [["py", ["-0p"]], ["where", ["python"]], ["where", ["python3"]]] : [["which", ["-a", "python3"]], ["which", ["-a", "python"]]];
  for (const [command, args] of commands) { const result = await exec(command, args, requireFn, 5_000); for (const line of result.stdout.split(/\r?\n/)) { const match = line.match(/(?:^|\s)([A-Za-z]:\\.*python(?:\.exe)?|\/.*python\d?(?:\.\d+)?)/i); if (match) add(match[1]!, command); else if (line.trim().startsWith("/")) add(line, command); } }
  for (const name of ["python3", "python", "python.exe"]) { const result = await exec(name, ["-c", "import sys; print(sys.executable)"], requireFn, 5_000); if (result.code === 0) add(result.stdout, "PATH"); }
  const globalPython = (await exec(os.platform() === "win32" ? "py" : "python", ["-c", "import sys; print(sys.executable)"], requireFn, 5_000, environment)).stdout.trim();
  const globalKey = globalPython ? realpathKey(fs, path.normalize(globalPython)) : "";

  // 探测并发验证，避免装了很多解释器的机器上串行等待几十秒。
  const entries = [...candidates.entries()];
  interface Probed { realKey: string; displayPath: string; aliases: Set<string>; source: string; major: number; minor: number; micro: string; arch: string; prefixKey: string; }
  const probed: Probed[] = [];
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [realKey, metadata] = entries[cursor++]!;
      const result = await exec(metadata.displayPath, ["-c", PYTHON_PROBE], requireFn, 5_000);
      done += 1;
      onProgress?.(done, entries.length);
      const parts = result.stdout.trim().split("\t");
      const version = parts[0]?.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!version || parts.length < 3) continue;
      const major = Number(version[1]);
      const minor = Number(version[2]);
      if (major !== 3) continue;
      // 同一安装的 python/python3 在 Windows 上是独立文件（不像 macOS 是符号链接），
      // 但 sys.prefix 相同——用它作为跨文件名的合并键。
      probed.push({
        realKey, displayPath: metadata.displayPath, aliases: metadata.aliases, source: metadata.source,
        major, minor, micro: version[3]!, arch: parts[1]!, prefixKey: realpathKey(fs, path.normalize(parts.slice(2).join("\t"))),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));

  interface Merged { displayPath: string; aliases: Set<string>; source: string; major: number; minor: number; micro: string; arch: string; global: boolean; }
  const displayScore = (p: string): number => {
    const base = path.basename(p).toLowerCase();
    return base === "python.exe" || base === "python3" ? 0 : base === "python" || base === "python3.exe" ? 1 : 2;
  };
  const merged = new Map<string, Merged>();
  for (const item of probed) {
    const key = `${item.prefixKey}|${item.major}.${item.minor}.${item.micro}|${item.arch}`;
    const current = merged.get(key) ?? {
      displayPath: item.displayPath, aliases: new Set<string>(), source: item.source,
      major: item.major, minor: item.minor, micro: item.micro, arch: item.arch, global: false,
    };
    for (const alias of item.aliases) current.aliases.add(alias);
    if (globalKey && item.realKey === globalKey) current.global = true;
    if (displayScore(item.displayPath) < displayScore(current.displayPath)
      || (displayScore(item.displayPath) === displayScore(current.displayPath) && item.displayPath.length < current.displayPath.length)) {
      current.displayPath = item.displayPath;
    }
    merged.set(key, current);
  }
  const out: PythonCandidate[] = [...merged.values()].map(item => ({
    path: item.displayPath,
    aliases: [...item.aliases].sort(),
    version: `${item.major}.${item.minor}.${item.micro}`,
    major: item.major,
    minor: item.minor,
    arch: item.arch,
    source: item.source,
    support: pythonSupport(item.major, item.minor),
    global: item.global,
  }));
  return out.sort((a, b) => b.minor - a.minor || a.path.localeCompare(b.path));
}

export interface DeploymentOptions {
  pdf2zhIndexUrl?: string;
  pdf2zhPythonMirror?: string;
  pdf2zhUvInstallerUrl?: string;
  pdf2zhUvGithubUrl?: string;
  pdf2zhUvDownloadUrl?: string;
  upgrade?: boolean;
  repair?: boolean;
  signal?: AbortSignal;
}

export function validateDownloadSources(options: DeploymentOptions): void {
  for (const [key, label] of [["pdf2zhIndexUrl", "Python 包索引"], ["pdf2zhPythonMirror", "Python 镜像"], ["pdf2zhUvInstallerUrl", "uv 安装脚本目录"], ["pdf2zhUvGithubUrl", "uv GitHub 镜像"], ["pdf2zhUvDownloadUrl", "uv 发布文件目录"]] as const) {
    const value = options[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    } catch { throw new Error(`${label}需填写 HTTP(S) 地址，不含账号、密码、查询参数或片段`); }
  }
}

export async function downloadEnvironment(options: DeploymentOptions, requireFn: NodeRequire): Promise<NodeJS.ProcessEnv> {
  validateDownloadSources(options);
  const env = await managedEnvironment(requireFn);
  if (options.pdf2zhIndexUrl?.trim()) {
    env.UV_DEFAULT_INDEX = options.pdf2zhIndexUrl.trim();
    env.UV_INDEX_URL = options.pdf2zhIndexUrl.trim();
    delete env.UV_INDEX;
    delete env.UV_EXTRA_INDEX_URL;
  }
  if (options.pdf2zhPythonMirror?.trim()) env.UV_PYTHON_INSTALL_MIRROR = options.pdf2zhPythonMirror.trim().replace(/\/+$/, "");
  if (options.pdf2zhUvGithubUrl?.trim()) {
    env.UV_INSTALLER_GITHUB_BASE_URL = options.pdf2zhUvGithubUrl.trim().replace(/\/+$/, "");
    for (const key of ["UV_DOWNLOAD_URL", "INSTALLER_DOWNLOAD_URL", "UV_INSTALLER_GHE_BASE_URL"]) delete env[key];
  }
  if (options.pdf2zhUvDownloadUrl?.trim()) env.UV_DOWNLOAD_URL = options.pdf2zhUvDownloadUrl.trim().replace(/\/+$/, "");
  return env;
}

/** Bootstrap the native uv executable without requiring Python, pip or venv. */
export async function installUv(options: DeploymentOptions = {}, requireFn: NodeRequire = getNodeRequire()!, onLine?: (line: string) => void): Promise<CommandResult> {
  const env = await downloadEnvironment(options, requireFn);
  const paths = deploymentPaths(requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const win = os.platform() === "win32";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "paper-manager-uv-"));
  const script = path.join(temp, win ? "install.ps1" : "install.sh");
  env.UV_UNMANAGED_INSTALL = paths.uvBin;
  env.UV_NO_MODIFY_PATH = "1";
  env.PAPER_MANAGER_UV_SCRIPT = script;
  env.PAPER_MANAGER_UV_URL = uvInstallerScriptUrl(options.pdf2zhUvInstallerUrl, win);
  try {
    onLine?.("正在下载安装 uv；不需要预先安装 Python…");
    const downloaded = await spawnLogged(win ? "powershell.exe" : "curl", win
      ? ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri $env:PAPER_MANAGER_UV_URL -OutFile $env:PAPER_MANAGER_UV_SCRIPT"]
      : ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "30", "--max-time", "180", "--output", script, env.PAPER_MANAGER_UV_URL],
    { requireFn, env, timeoutMs: 200_000, onLine, signal: options.signal });
    if (downloaded.code !== 0) return downloaded;
    return await spawnLogged(win ? "powershell.exe" : "sh", win
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] : [script],
    { requireFn, env, timeoutMs: 600_000, onLine, signal: options.signal });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function installPdf2zh(pythonPath: string, uv: UvCommand, requireFn: NodeRequire = getNodeRequire()!, onLine?: (line: string) => void, options: DeploymentOptions = {}): Promise<CommandResult> {
  const env = await downloadEnvironment(options, requireFn);
  if (pythonPath) await validateDeploymentPython(pythonPath, requireFn);
  const [file, args] = uvInvocation(uv, ["tool", "install", ...(options.upgrade ? ["--upgrade"] : []), ...(options.repair ? ["--reinstall"] : []), "--python", pythonPath || "3.12", "--with", PDF2ZH_COMPAT_REQUIREMENT, "pdf2zh", ...(options.pdf2zhIndexUrl?.trim() ? ["--no-config"] : [])]);
  onLine?.(pythonPath ? "使用指定 Python 安装 pdf2zh…" : "正在查找 Python 3.12；缺少时由 uv 下载，然后安装 pdf2zh…");
  return spawnLogged(file, args, { requireFn, timeoutMs: 1_800_000, onLine, env, signal: options.signal });
}

export async function inspectPdf2zh(requireFn: NodeRequire = getNodeRequire()!, pythonPath?: string): Promise<InstalledPdf2zh | null> {
  const uv = await findUv(requireFn, pythonPath);
  if (!uv) return null;
  const listed = await runUv(uv, ["tool", "list", "--show-paths", "--show-python"], requireFn, 8_000);
  if (listed.code !== 0 || !/^pdf2zh\b/im.test(listed.stdout)) return null;
  const bin = await resolvePdf2zh(uv, requireFn);
  if (!bin) return null;
  const version = listed.stdout.match(/^pdf2zh\s+v([^\s]+)/im)?.[1];
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const toolDir = (await runUv(uv, ["tool", "dir"], requireFn, 5_000)).stdout.trim();
  let interpreterPath: string | undefined;
  const win = process.platform === "win32";
  const envCfg = path.join(toolDir, "pdf2zh", "pyvenv.cfg");
  if (fs.existsSync(envCfg)) {
    const cfg = fs.readFileSync(envCfg, "utf8");
    const home = cfg.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
    const basePython = home ? path.join(home, win ? "python.exe" : "python") : undefined;
    if (basePython && fs.existsSync(basePython)) interpreterPath = basePython;
    else {
      const interpreter = path.join(toolDir, "pdf2zh", win ? "Scripts" : "bin", win ? "python.exe" : "python");
      if (fs.existsSync(interpreter)) interpreterPath = interpreter;
    }
  }
  return { executable: bin, pythonPath: interpreterPath, version, toolDir };
}

export async function uninstallPdf2zh(requireFn: NodeRequire = getNodeRequire()!, pythonPath?: string, onLine?: (line: string) => void): Promise<CommandResult> {
  const uv = await findUv(requireFn, pythonPath);
  if (!uv) return { stdout: "", stderr: "未找到 uv", code: 1 };
  const [file, args] = uvInvocation(uv, ["tool", "uninstall", "pdf2zh"]);
  return spawnLogged(file, args, { requireFn, timeoutMs: 120_000, onLine, env: await managedEnvironment(requireFn) });
}

export async function resolvePdf2zh(uv: UvCommand, requireFn: NodeRequire = getNodeRequire()!, managed = true): Promise<string | null> {
  const result = await runUv(uv, ["tool", "dir", "--bin"], requireFn, 5_000, managed);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  if (result.code !== 0) return null;
  const dir = result.stdout.trim();
  for (const name of process.platform === "win32" ? ["pdf2zh.exe", "pdf2zh"] : ["pdf2zh"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function detectPdf2zh(requireFn: NodeRequire = getNodeRequire()!): Promise<string | null> {
  const uv = await findUv(requireFn);
  if (uv) { const installed = await resolvePdf2zh(uv, requireFn, false); if (installed) return installed; }
  const result = await exec(process.platform === "win32" ? "where" : "which", ["pdf2zh"], requireFn, 5_000);
  return result.code === 0 ? result.stdout.split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? null : null;
}

export function configPath(workspaceDir: string, pluginName = PLUGIN_NAME, requireFn: NodeRequire = getNodeRequire()!): string {
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  return path.join(workspaceDir, "data", "plugins", pluginName, "pdf2zh", "config.json");
}

export function systemConfigPath(requireFn: NodeRequire = getNodeRequire()!): string {
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const home = os.homedir();
  return path.join(home, ".config", "PDFMathTranslate", "config.json");
}
