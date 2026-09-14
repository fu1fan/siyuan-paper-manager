import { getNodeRequire, requireNode, type NodeRequire } from "../core/env";

export interface PythonCandidate { path: string; aliases: string[]; version: string; major: number; minor: number; arch: string; source: string; supported: boolean; global: boolean; }
export interface CommandResult { stdout: string; stderr: string; code: number; }
export interface InstalledPdf2zh { executable: string; pythonPath?: string; version?: string; toolDir?: string; }

type ExecFile = (file: string, args: string[], options: Record<string, unknown>, callback: (error: any, stdout: string, stderr: string) => void) => void;

let shellEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * Electron apps launched by Finder inherit launchd's minimal environment.
 * VS Code resolves the user's login-shell environment before running its
 * Python locators; do the same for the standalone SiYuan renderer.
 */
export function resolveShellEnvironment(requireFn: NodeRequire = getNodeRequire()!): Promise<NodeJS.ProcessEnv> {
  if (shellEnvironmentPromise) return shellEnvironmentPromise;
  if (process.platform === "win32") return Promise.resolve({ ...process.env });
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

export async function scanPython(requireFn: NodeRequire = getNodeRequire()!): Promise<PythonCandidate[]> {
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const environment = await resolveShellEnvironment(requireFn);
  const candidates = new Map<string, { displayPath: string; source: string; aliases: Set<string> }>();
  const add = (value: string, source: string) => {
    const p = value.trim().replace(/^['"]|['"]$/g, "");
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return;
    const normalized = path.normalize(p);
    let key = normalized;
    try { key = fs.realpathSync.native(normalized); } catch { try { key = fs.realpathSync(normalized); } catch { /* retain normalized path */ } }
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
  for (const command of ["conda", "mamba"]) { const result = await exec(command, ["env", "list", "--json"], requireFn, 8_000); if (result.code === 0) { try { const dirs = JSON.parse(result.stdout).envs as string[]; for (const dir of dirs ?? []) addDir(path.join(dir, os.platform() === "win32" ? "Scripts" : "bin"), "conda"); } catch { /* ignore malformed manager output */ } } }
  if (os.platform() === "win32") {
    const result = await exec("reg", ["query", "HKCU\\Software\\Python\\PythonCore", "/s", "/v", "ExecutablePath"], requireFn, 8_000);
    for (const line of result.stdout.split(/\r?\n/)) { const match = line.match(/ExecutablePath\s+REG_SZ\s+(.+)$/i); if (match) add(match[1]!, "windows-registry"); }
    for (const dir of [environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps"), environment.ProgramFiles && path.join(environment.ProgramFiles, "WindowsApps")].filter(Boolean) as string[]) addDir(dir, "microsoft-store");
  }
  const commands: Array<[string, string[]]> = os.platform() === "win32" ? [["py", ["-0p"]], ["where", ["python"]], ["where", ["python3"]]] : [["which", ["-a", "python3"]], ["which", ["-a", "python"]]];
  for (const [command, args] of commands) { const result = await exec(command, args, requireFn, 5_000); for (const line of result.stdout.split(/\r?\n/)) { const match = line.match(/(?:^|\s)([A-Za-z]:\\.*python(?:\.exe)?|\/.*python\d?(?:\.\d+)?)/i); if (match) add(match[1]!, command); else if (line.trim().startsWith("/")) add(line, command); } }
  for (const name of ["python3", "python", "python.exe"]) { const result = await exec(name, ["-c", "import sys; print(sys.executable)"], requireFn, 5_000); if (result.code === 0) add(result.stdout, "PATH"); }
  const globalPython = (await exec(os.platform() === "win32" ? "py" : "python", ["-c", "import sys; print(sys.executable)"], requireFn, 5_000, environment)).stdout.trim();
  const out: PythonCandidate[] = [];
  for (const [realPythonPath, metadata] of candidates) {
    const pythonPath = metadata.displayPath;
    const result = await exec(pythonPath, ["-c", "import platform,sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\\t{platform.machine()}')"], requireFn, 5_000);
    const match = result.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)\s+(.+)$/); if (!match) continue;
    const major = Number(match[1]); const minor = Number(match[2]);
    if (major !== 3) continue;
    let globalPath = path.normalize(globalPython);
    try { globalPath = fs.realpathSync.native(globalPath); } catch { /* keep normalized */ }
    out.push({ path: pythonPath, aliases: [...metadata.aliases].sort(), version: `${major}.${minor}.${match[3]}`, major, minor, arch: match[4]!, source: metadata.source, supported: minor >= 11 && minor <= 13, global: globalPath === realPythonPath });
  }
  return out.sort((a, b) => b.minor - a.minor || a.path.localeCompare(b.path));
}

export async function findUv(requireFn: NodeRequire = getNodeRequire()!): Promise<string | null> {
  for (const name of process.platform === "win32" ? ["uv.exe", "uv"] : ["uv"]) { const result = await exec(name, ["--version"], requireFn, 5_000); if (result.code === 0) return name; }
  return null;
}

export async function installUv(pythonPath: string, requireFn: NodeRequire = getNodeRequire()!): Promise<CommandResult> {
  return exec(pythonPath, ["-m", "pip", "install", "--user", "uv"], requireFn, 180_000);
}

export async function installPdf2zh(pythonPath: string, uv: string, requireFn: NodeRequire = getNodeRequire()!): Promise<CommandResult> {
  return exec(uv, ["tool", "install", "--force", "--python", pythonPath, "pdf2zh"], requireFn, 300_000);
}

export async function inspectPdf2zh(requireFn: NodeRequire = getNodeRequire()!): Promise<InstalledPdf2zh | null> {
  const uv = await findUv(requireFn); if (!uv) return null;
  const listed = await exec(uv, ["tool", "list", "--show-paths", "--show-python"], requireFn, 8_000);
  if (listed.code !== 0 || !/^pdf2zh\b/im.test(listed.stdout)) return null;
  const bin = await resolvePdf2zh(uv, requireFn); if (!bin) return null;
  const version = listed.stdout.match(/^pdf2zh\s+v([^\s]+)/im)?.[1];
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const fs = requireNode<typeof import("node:fs")>("fs", requireFn);
  const toolDir = (await exec(uv, ["tool", "dir"], requireFn, 5_000)).stdout.trim();
  let pythonPath: string | undefined;
  const envCfg = path.join(toolDir, "pdf2zh", "pyvenv.cfg");
  if (fs.existsSync(envCfg)) { const cfg = fs.readFileSync(envCfg, "utf8"); const home = cfg.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim(); if (home) pythonPath = path.join(home, "python"); else { const interpreter = path.join(toolDir, "pdf2zh", "bin", "python"); if (fs.existsSync(interpreter)) pythonPath = interpreter; } }
  return { executable: bin, pythonPath, version, toolDir };
}

export async function uninstallPdf2zh(requireFn: NodeRequire = getNodeRequire()!): Promise<CommandResult> {
  const uv = await findUv(requireFn); if (!uv) return { stdout: "", stderr: "未找到 uv", code: 1 };
  return exec(uv, ["tool", "uninstall", "pdf2zh"], requireFn, 120_000);
}

export async function resolvePdf2zh(uv: string, requireFn: NodeRequire = getNodeRequire()!): Promise<string | null> {
  const result = await exec(uv, ["tool", "dir", "--bin"], requireFn, 5_000);
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
  if (uv) { const installed = await resolvePdf2zh(uv, requireFn); if (installed) return installed; }
  const result = await exec(process.platform === "win32" ? "where" : "which", ["pdf2zh"], requireFn, 5_000);
  return result.code === 0 ? result.stdout.split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? null : null;
}

export function configPath(workspaceDir: string, pluginName = "siyuan-paper-manager", requireFn: NodeRequire = getNodeRequire()!): string {
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  return path.join(workspaceDir, "data", "plugins", pluginName, "pdf2zh", "config.json");
}

export function systemConfigPath(requireFn: NodeRequire = getNodeRequire()!): string {
  const path = requireNode<typeof import("node:path")>("path", requireFn);
  const os = requireNode<typeof import("node:os")>("os", requireFn);
  const home = os.homedir();
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "PDFMathTranslate", "config.json")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "PDFMathTranslate", "config.json");
}
